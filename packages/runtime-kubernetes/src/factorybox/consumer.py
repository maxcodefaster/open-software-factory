"""Own one versioned consumer export without changing the original worker."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


ROOT = Path('/var/lib/sysbox/consumer-seeds')


def publish(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    original = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        current = path.lstat()
        if (current.st_dev, current.st_ino, current.st_nlink) == (original.st_dev, original.st_ino, 1):
            path.unlink()
        raise
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Consumer export directory identity changed')


def read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise ValueError('Consumer export receipt is not its original private file')
    return json.loads(path.read_text())


def export(request):
    if type(request) is not dict or request.get('action') not in {'begin', 'observe', 'complete'}:
        raise ValueError('Unknown consumer export command')
    expected = {'intent', 'action', 'existingUID' if request['action'] == 'begin' else 'exporterUID'}
    if set(request) != expected or type(request['intent']) is not dict:
        raise ValueError('Unexpected consumer export fields')
    plan = request['intent']
    if (set(plan) != {'version', 'storeID', 'epoch', 'podUID', 'image', 'exporterName'} or
            type(plan['version']) is not int or plan['version'] != 1 or
            not all(isinstance(plan[key], str) for key in ['storeID', 'epoch', 'podUID', 'image', 'exporterName']) or
            not all(re.fullmatch('[a-f0-9]{32}', plan[key]) for key in ['storeID', 'epoch']) or
            not re.fullmatch(r'[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}', plan['image']) or
            plan['storeID'] != os.environ['FACTORY_STORE_ID'] or plan['podUID'] != os.environ['FACTORY_POD_UID']):
        raise ValueError('Consumer export differs from its original worker')
    status = json.loads(subprocess.check_output(['/opt/factorybox/factorybox', 'worker-status'], timeout=10))
    if status['store_id'] != plan['storeID'] or status['epoch'] != plan['epoch']:
        raise ValueError('Consumer export worker epoch changed')
    key = hashlib.sha256(plan['image'].encode()).hexdigest()
    if plan['exporterName'] != 'consumer-'+key[:48]:
        raise ValueError('Consumer exporter name differs from its immutable image')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    directory(ROOT)
    descriptor = os.open(ROOT/'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        root = ROOT/key
        fresh = not root.exists() and not root.is_symlink()
        if fresh:
            if request['action'] != 'begin' or request.get('existingUID') is not None:
                raise ValueError('Refusing an exporter without its persisted original intent')
            root.mkdir(mode=0o700)
            publish(root/'intent.json', plan)
        directory(root)
        if read(root/'intent.json') != plan:
            raise ValueError('Consumer export belongs to another image or worker')
        complete = root/'complete.json'
        if complete.exists():
            saved = read(complete)
            if saved['intent'] != plan or not saved['exporterUID']:
                raise ValueError('Consumer completion belongs to another export')
            return {'create': False, 'complete': True, 'exporterUID': saved['exporterUID'],
                    'subPath': 'consumer-seeds/'+key}
        attempted = root/'attempted.json'
        if request['action'] == 'begin':
            create = fresh
            if create:
                publish(attempted, plan)
            elif read(attempted) != plan:
                raise ValueError('Consumer create attempt remains unconfirmed')
            return {'create': create, 'complete': False, 'subPath': 'consumer-seeds/'+key}
        uid = request['exporterUID']
        if not isinstance(uid, str) or not uid or len(uid) > 128:
            raise ValueError('Consumer export needs its original Pod UID')
        if read(attempted) != plan:
            raise ValueError('Consumer create attempt belongs to another image')
        observed = root/'observed.json'
        if observed.exists():
            if read(observed) != {'exporterUID': uid}:
                raise ValueError('Consumer exporter Pod UID changed')
        else:
            publish(observed, {'exporterUID': uid})
        if request['action'] == 'complete':
            if ((root/'exporter-uid').read_text() != uid or
                    (root/'intent').read_text().splitlines() != [plan['podUID'], plan['storeID'], plan['image']]):
                raise ValueError('Consumer filesystem belongs to another exporter or image')
            expected = (root/'rootfs.sha256').read_text().split()
            digest = hashlib.sha256()
            with (root/'rootfs.tar').open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            if expected != [digest.hexdigest(), 'rootfs.tar']:
                raise ValueError('Consumer filesystem differs from its committed export')
            publish(complete, {'intent': plan, 'exporterUID': uid, 'rootfsSHA256': digest.hexdigest()})
        elif request['action'] != 'observe':
            raise ValueError('Unknown consumer export command')
        return {'create': False, 'complete': complete.exists(), 'exporterUID': uid,
                'subPath': 'consumer-seeds/'+key}


if __name__ == '__main__':
    print(json.dumps(export(json.load(sys.stdin))))
