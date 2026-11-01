"""Retire completed transport archives of a positively terminated admission."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ValueError('Export directory owner or permissions changed')
    return {'device': info.st_dev, 'inode': info.st_ino}


def regular(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise ValueError('Export file owner, type or links changed')
    return info


def read(path, limit=65536):
    regular(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        text = stream.read(limit+1)
        if len(text) > limit:
            raise ValueError('Export metadata exceeds its bound')
        return text


def present(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def publish(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_nlink) == (identity.st_dev, identity.st_ino, 1):
            path.unlink()
        raise
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def file_identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'bytes': info.st_size,
            'mtimeNS': info.st_mtime_ns, 'ctimeNS': info.st_ctime_ns}


def retire_one(root, owner, image):
    original_directory = directory(root)
    if read(root/'intent').splitlines() != [owner['podUID'], owner['storeID'], image]:
        raise ValueError('Export belongs to another original Pod or image')
    checksum = read(root/'rootfs.sha256', 256).split()
    if len(checksum) != 2 or not re.fullmatch('[a-f0-9]{64}', checksum[0]) or checksum[1] != 'rootfs.tar':
        raise ValueError('Export has no committed archive checksum')
    descriptor = os.open(root/'.archive-retirement.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        regular(root/'.archive-retirement.lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        binding = {'version': 1, 'owner': owner, 'image': image,
                   'sha256': checksum[0], 'directory': original_directory}
        intent_path, complete_path = root/'archive-retirement.json', root/'archive-retired.json'
        archive = root/'rootfs.tar'
        saved = json.loads(read(intent_path)) if present(intent_path) else None
        if saved is not None:
            if (type(saved) is not dict or set(saved) != {'binding', 'file'} or
                    saved['binding'] != binding or type(saved['file']) is not dict or
                    set(saved['file']) != {'device', 'inode', 'bytes', 'mtimeNS', 'ctimeNS'} or
                    any(type(value) is not int for value in saved['file'].values())):
                raise ValueError('Archive retirement belongs to another owner or directory')
        if present(complete_path):
            if saved is None or json.loads(read(complete_path)) != {'version': 1, 'retirement': saved} or present(archive):
                raise ValueError('Completed archive retirement has a replacement or changed receipt')
            return {'image': image, 'bytes': saved['file']['bytes'], 'alreadyCompleted': True}
        if saved is None:
            info = regular(archive)
            identity = file_identity(info)
            digest = hashlib.sha256()
            fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                if file_identity(os.fstat(stream.fileno())) != identity:
                    raise ValueError('Archive changed before hashing')
                for block in iter(lambda: stream.read(1024*1024), b''):
                    digest.update(block)
                if file_identity(os.fstat(stream.fileno())) != identity:
                    raise ValueError('Archive changed while hashing')
            if digest.hexdigest() != checksum[0]:
                raise ValueError('Archive differs from its committed export')
            saved = {'binding': binding, 'file': identity}
            publish(intent_path, saved)
        # A lost reply continues this same inventory. It never removes an
        # unexpected successor or infers an original create from absence.
        if present(archive):
            if file_identity(regular(archive)) != saved['file']:
                raise ValueError('Archive identity changed after retirement intent')
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                opened = os.fstat(fd)
                if {'device': opened.st_dev, 'inode': opened.st_ino} != original_directory:
                    raise ValueError('Archive directory was replaced')
                current = os.stat('rootfs.tar', dir_fd=fd, follow_symlinks=False)
                if file_identity(current) != saved['file'] or current.st_nlink != 1:
                    raise ValueError('Archive was replaced before unlink')
                os.unlink('rootfs.tar', dir_fd=fd)
                os.fsync(fd)
            finally:
                os.close(fd)
        publish(complete_path, {'version': 1, 'retirement': saved})
        return {'image': image, 'bytes': saved['file']['bytes'], 'alreadyCompleted': False}


def imported_base_identity(base, source, saved, base_id, status):
    if type(base) is not dict:
        raise ValueError('Consumer has no native base record')
    tree = base.get('tree', {})
    if type(tree) is not dict or type(tree.get('immutable')) is not dict:
        raise ValueError('Consumer native base has no immutable tree')
    if (base.get('version') != 1 or base.get('id') != base_id or
            base.get('source') != str(source) or base.get('boot_id') != status.get('boot_id') or
            base.get('runtime_sha256') != status['lifecycle'].get('runtime_sha256') or
            not base.get('prepared_at') or tree.get('source') != str(source) or
            tree.get('saved') != str(saved) or tree.get('immutable', {}).get('root') != str(saved) or
            not re.fullmatch('[a-f0-9]{64}', tree.get('sha256', ''))):
        raise ValueError('Consumer has no exact independent native base')
    identity = {key: base[key] for key in
                ['version', 'id', 'source', 'boot_id', 'runtime_sha256', 'prepared_at']}
    identity['tree'] = {'saved': str(saved), 'sha256': tree['sha256']}
    return identity


def retire_imported_exports(root, request, status, environment=None):
    deadline = time.monotonic() + 420
    environment = os.environ if environment is None else environment
    fields = {'version', 'storeID', 'epoch', 'podUID', 'admissionID'}
    namespace = environment.get('FACTORY_SEED_NAMESPACE', '')
    if (type(request) is not dict or set(request) != fields or
            type(request['version']) is not int or request['version'] != 1 or
            any(not isinstance(request[key], str) or not re.fullmatch('[a-f0-9]{32}', request[key])
                for key in ['storeID', 'epoch', 'admissionID']) or
            not isinstance(request['podUID'], str) or not request['podUID'] or
            len(request['podUID']) > 128 or
            status.get('store_id') != request['storeID'] or status.get('epoch') != request['epoch'] or
            environment.get('FACTORY_STORE_ID') != request['storeID'] or
            environment.get('FACTORY_POD_UID') != request['podUID'] or
            (namespace != request['admissionID'] if namespace else
             request['admissionID'] != request['storeID'])):
        raise ValueError('Imported export retirement differs from its current worker')
    directory(root)
    home = root/'consumer-seeds'
    result = {'version': 1, 'retired': [], 'refused': [], 'missing': []}
    if not present(home):
        return result
    directory(home)
    if namespace:
        home = home/namespace
        if not present(home):
            return result
        directory(home)
    owner = {key: request[key] for key in ['admissionID', 'podUID', 'epoch', 'storeID']}
    for seed in home.iterdir():
        if not re.fullmatch('[a-f0-9]{64}', seed.name):
            continue
        try:
            directory(seed)
            descriptor = os.open(seed/'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'r+') as lock:
                regular(seed/'.lock')
                fcntl.flock(lock, fcntl.LOCK_EX)
                plan = json.loads(read(seed/'intent.json'))
                if type(plan) is not dict:
                    raise ValueError('Consumer export intent is not an object')
                image = plan.get('image', '')
                if (set(plan) != {'version', 'storeID', 'epoch', 'podUID', 'image', 'exporterName'} or
                        plan['version'] != 1 or any(plan[key] != request[key]
                            for key in ['storeID', 'epoch', 'podUID']) or
                        not re.fullmatch(r'[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}', image) or
                        hashlib.sha256(image.encode()).hexdigest() != seed.name):
                    raise ValueError('Consumer export belongs to another worker or image')
                name_key = hashlib.sha256((namespace+':'+image).encode()).hexdigest() if namespace else seed.name
                complete = json.loads(read(seed/'complete.json'))
                checksum = read(seed/'rootfs.sha256', 256).split()
                if (type(complete) is not dict or plan['exporterName'] != 'consumer-'+name_key[:48] or
                        complete.get('intent') != plan or not complete.get('exporterUID') or
                        read(seed/'exporter-uid') != complete['exporterUID'] or
                        len(checksum) != 2 or checksum[1] != 'rootfs.tar' or
                        not re.fullmatch('[a-f0-9]{64}', checksum[0]) or
                        complete.get('rootfsSHA256') != checksum[0]):
                    raise ValueError('Consumer has no exact successful export')
                imported = seed/'import'
                directory(imported)
                expected = {'version': 1, 'storeID': request['storeID'], 'epoch': request['epoch'],
                            'podUID': request['podUID'], 'runtimeHostImage': image,
                            'rootfsSHA256': checksum[0]}
                if json.loads(read(imported/'prepared.json')) != expected or present(imported/'source'):
                    raise ValueError('Consumer import is partial or has a source successor')
                base_id = 'runtime-'+seed.name[:55]
                base_root = Path(status['lifecycle']['root'])/'bases'/base_id
                directory(base_root)
                source, saved = imported/'source', base_root/'rootfs'
                identity = imported_base_identity(
                    json.loads(read(base_root/'base.json')), source, saved, base_id, status)
                if json.loads(read(imported/'source-retired.json')) != {'version': 1, 'base': identity}:
                    raise ValueError('Consumer import retirement differs from its native base')
                authority = {'version': 1, 'import': expected, 'base': identity}
                authority_path = seed/'import-archive-authority.json'
                if present(authority_path) and json.loads(read(authority_path)) != authority:
                    raise ValueError('Imported archive authority changed')
                if not present(seed/'archive-retired.json'):
                    # The complete native base must already exist. Replaying its
                    # exact PrepareBase only verifies that independent copy; the
                    # original extraction is absent and cannot recreate it.
                    cli = ['/opt/factorybox/factorybox', '--worker-run-root', '/run/factorybox',
                           '--worker-store-id', request['storeID'], '--worker-epoch', request['epoch']]
                    observed = json.loads(subprocess.check_output(
                        [*cli, 'prepare-base', '--source', str(source), base_id],
                        timeout=max(0.001, deadline-time.monotonic())))
                    if imported_base_identity(observed, source, saved, base_id, status) != identity:
                        raise ValueError('Independent native consumer copy changed')
                    if not present(authority_path):
                        publish(authority_path, authority)
                elif not present(authority_path):
                    raise ValueError('Imported archive completion lost its native authority')
                result['retired'].append(retire_one(seed, owner, image))
        except (ValueError, OSError, json.JSONDecodeError,
                subprocess.CalledProcessError, subprocess.TimeoutExpired):
            result['refused'].append(seed.name)
    return result


def retire_exports(root, request, status, environment=None):
    environment = os.environ if environment is None else environment
    if type(request) is not dict or set(request) != {'version', 'storeID', 'epoch', 'podUID', 'admissionID', 'previous'}:
        raise ValueError('Unexpected export retirement request')
    previous = request['previous']
    if (type(request['version']) is not int or request['version'] != 1 or
            type(previous) is not dict or set(previous) !=
            {'admissionID', 'podUID', 'epoch', 'image', 'seedNamespace', 'terminal'} or
            any(not isinstance(request[key], str) or not re.fullmatch('[a-f0-9]{32}', request[key])
                for key in ['storeID', 'epoch', 'admissionID']) or
            status.get('store_id') != request['storeID'] or status.get('epoch') != request['epoch'] or
            environment.get('FACTORY_STORE_ID') != request['storeID'] or
            environment.get('FACTORY_POD_UID') != request['podUID'] or
            environment.get('FACTORY_SEED_NAMESPACE') != request['admissionID'] or
            any(not isinstance(value, str) or not value or len(value) > 128
                for value in [request['podUID'], previous['podUID']]) or
            not isinstance(previous['admissionID'], str) or not re.fullmatch('[a-f0-9]{32}', previous['admissionID']) or
            previous['admissionID'] == request['admissionID'] or previous['podUID'] == request['podUID'] or
            (previous['epoch'] is not None and
             (not isinstance(previous['epoch'], str) or not re.fullmatch('[a-f0-9]{32}', previous['epoch']) or
              previous['epoch'] == request['epoch'])) or
            previous['terminal'] not in [
                {'podUID': previous['podUID'], 'phase': 'Succeeded'},
                {'podUID': previous['podUID'], 'phase': 'Failed'}] or
            not isinstance(previous['image'], str) or
            not re.fullmatch(r'[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}', previous['image']) or
            (previous['seedNamespace'] is not None and previous['seedNamespace'] != previous['admissionID'])):
        raise ValueError('Export retirement has no distinct current worker and terminal original owner')
    directory(root)
    owner = {key: previous[key] for key in ['admissionID', 'podUID', 'epoch']}
    owner['storeID'] = request['storeID']
    result = {'version': 1, 'retired': [], 'refused': [], 'missing': []}

    def retire(path, image):
        try:
            result['retired'].append(retire_one(path, owner, image))
        except FileNotFoundError:
            result['missing'].append(image)
        except (ValueError, OSError, json.JSONDecodeError):
            # Foreign or partial exports do not authorize any deletion and
            # need not block otherwise safe cleanup of independent archives.
            result['refused'].append(image)

    namespace = previous['seedNamespace']
    if namespace:
        seeds = root/'seeds'
        if present(seeds):
            directory(seeds)
            scoped = seeds/namespace
            if present(scoped):
                directory(scoped)
                retire(scoped/'bootstrap', previous['image'])
    else:
        retire(root/'seed', previous['image'])
    consumers = root/'consumer-seeds'
    if not present(consumers) or previous['epoch'] is None:
        return result
    directory(consumers)
    if namespace:
        consumers = consumers/namespace
        if not present(consumers):
            return result
        directory(consumers)
    for path in consumers.iterdir():
        if not re.fullmatch('[a-f0-9]{64}', path.name):
            continue
        try:
            directory(path)
            plan = json.loads(read(path/'intent.json'))
            if (type(plan) is not dict or set(plan) !=
                    {'version', 'storeID', 'epoch', 'podUID', 'image', 'exporterName'} or
                    plan.get('version') != 1 or plan.get('storeID') != owner['storeID'] or
                    plan.get('podUID') != owner['podUID'] or plan.get('epoch') != owner['epoch']):
                continue
            image = plan.get('image')
            name_key = hashlib.sha256((namespace+':'+image).encode()).hexdigest() if namespace and isinstance(image, str) else path.name
            if (not isinstance(image, str) or hashlib.sha256(image.encode()).hexdigest() != path.name or
                    plan['exporterName'] != 'consumer-'+name_key[:48]):
                raise ValueError('Consumer export image changed')
            saved = json.loads(read(path/'complete.json'))
            checksum = read(path/'rootfs.sha256', 256).split()
            if (type(saved) is not dict or set(saved) != {'intent', 'exporterUID', 'rootfsSHA256'} or
                    saved.get('intent') != plan or not saved.get('exporterUID') or
                    read(path/'exporter-uid') != saved['exporterUID'] or
                    not checksum or saved.get('rootfsSHA256') != checksum[0]):
                raise ValueError('Consumer export has no exact successful completion')
            retire(path, image)
        except (ValueError, OSError, json.JSONDecodeError):
            result['refused'].append(path.name)
    return result


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise ValueError('Export retirement requires the admitted root worker')
    current = json.loads(subprocess.check_output(['/opt/factorybox/factorybox', 'worker-status'], timeout=10))
    operation = retire_imported_exports if sys.argv[1:] == ['imported'] else retire_exports
    if sys.argv[1:] not in [[], ['imported']]:
        raise ValueError('Unknown export retirement operation')
    print(json.dumps(operation(Path('/var/lib/sysbox'), json.load(sys.stdin), current)))
