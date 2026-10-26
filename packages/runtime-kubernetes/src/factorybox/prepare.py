"""Prepare one Factory-owned OCI input inside an admitted live worker."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def publish(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def input_mounts(bundle):
    paths = {str(bundle/name) for name in ['rootfs', 'lower']}
    rows = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if any(target == path or target.startswith(path+'/') for path in paths):
            if target not in paths or target in rows:
                raise ValueError('Unexpected nested or stacked private input mount')
            info = os.stat(target, follow_symlinks=False)
            rows[target] = {'mountinfo': line, 'device': info.st_dev, 'inode': info.st_ino}
    return rows


def image_base(request, status, seed, rootfs_sha256, cli):
    # All Sandboxes on this worker use one exact consumer image. Serialize its
    # import, rather than extracting another multi-gigabyte source per Sandbox.
    images = Path(status['store'])/'consumer-images'
    images.mkdir(mode=0o700, exist_ok=True)
    descriptor = os.open(images/'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        root = images/rootfs_sha256
        intent = {'version': 1, 'storeID': request['storeID'], 'epoch': request['epoch'],
                  'podUID': request['podUID'], 'runtimeHostImage': request['runtimeHostImage'],
                  'rootfsSHA256': rootfs_sha256}
        if root.exists():
            if json.loads((root/'prepared.json').read_text()) != intent:
                raise ValueError('Shared consumer image import is incomplete or belongs to another identity')
        else:
            root.mkdir(mode=0o700)
            publish(root/'intent.json', intent)
            source = root/'source'
            source.mkdir(mode=0o755)
            subprocess.run(['tar', '--numeric-owner', '--same-owner', '-xpf', str(seed/'rootfs.tar'),
                            '-C', str(source)], check=True, timeout=90)
            for directory in ['proc', 'sys', 'dev', 'run', 'tmp', 'workspace',
                              'factory/assignment', 'factory/registry-ca', 'home/coder']:
                (source/directory).mkdir(parents=True, exist_ok=True)
            # No authored checkout may be baked into the common image.
            # A shared-source mountpoint is created later in that Sandbox's upper.
            project = source/'home/coder/project'
            if project.exists():
                project.rmdir()
            (source/'tmp').chmod(0o1777)
            publish(root/'prepared.json', intent)
        return json.loads(subprocess.check_output(
            [*cli, 'prepare-base', '--source', str(root/'source'), 'factory-runtime'], timeout=120))


def prepare(request):
    request.setdefault('reserveSeed', False)
    if set(request) != {'version', 'sandboxID', 'storeID', 'epoch', 'podUID', 'runtimeHostImage', 'sharedSource', 'bootstrap', 'reserveSeed'}:
        raise ValueError('Unexpected Factory preparation fields')
    if (request['version'] != 2 or not re.fullmatch(r'runtime-[a-f0-9]{32}', request['sandboxID']) or
            type(request['sharedSource']) is not bool or type(request['reserveSeed']) is not bool or
            (request['reserveSeed'] and request['sharedSource']) or
            not all(re.fullmatch('[a-f0-9]{32}', request[key]) for key in ['storeID', 'epoch']) or
            not re.fullmatch(r'[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}', request['runtimeHostImage']) or
            request['podUID'] != os.environ['FACTORY_POD_UID'] or
            request['storeID'] != os.environ['FACTORY_STORE_ID'] or
            len(request['bootstrap']) > 16384):
        raise ValueError('Factory preparation identity differs from the admitted Pod')
    cli = ['/opt/factorybox/factorybox', '--worker-run-root', '/run/factorybox',
           '--worker-store-id', request['storeID'], '--worker-epoch', request['epoch']]
    status = json.loads(subprocess.check_output(['/opt/factorybox/factorybox', 'worker-status'], timeout=10))
    if status['store_id'] != request['storeID'] or status['epoch'] != request['epoch']:
        raise ValueError('Worker identity changed before consumer preparation')
    seed = Path('/var/lib/sysbox/seed')
    if (seed/'intent').read_text().splitlines() != [request['podUID'], request['storeID'], request['runtimeHostImage']]:
        raise ValueError('Consumer export belongs to another Pod or image')
    expected = (seed/'rootfs.sha256').read_text().split()
    if len(expected) != 2 or expected[1] != 'rootfs.tar' or digest(seed/'rootfs.tar') != expected[0]:
        raise ValueError('Complete consumer rootfs differs from its committed export')
    root = Path(status['store'])/'input'/request['sandboxID']
    plan = {'request': request, 'rootfsSHA256': expected[0]}
    if root.exists():
        if json.loads((root/'intent.json').read_text()) != plan:
            raise ValueError('Private input already belongs to another preparation')
        completed = json.loads((root/'prepared.json').read_text())
        if (completed.get('version') != 2 or completed.get('sandboxID') != request['sandboxID'] or
                completed.get('bundle') != str(root/'bundle') or completed.get('storeID') != request['storeID'] or
                completed.get('epoch') != request['epoch'] or completed.get('podUID') != request['podUID'] or
                completed.get('rootfsSHA256') != expected[0] or
                digest(root/'bundle/config.json') != completed['configSHA256']):
            raise ValueError('Prepared OCI configuration changed')
        return completed
    root.parent.mkdir(mode=0o700, exist_ok=True)
    root.mkdir(mode=0o700)
    publish(root/'intent.json', plan)
    bundle = root/'bundle'
    bundle.mkdir(mode=0o700)
    base = image_base(request, status, seed, expected[0], cli)
    for name in ['lower', 'upper', 'work', 'rootfs']:
        (bundle/name).mkdir(mode=0o755)
    subprocess.run(['mount', '--bind', base['tree']['saved'], str(bundle/'lower')], check=True)
    subprocess.run(['mount', '-o', 'remount,bind,ro', str(bundle/'lower')], check=True)
    subprocess.run(['mount', '-t', 'overlay', 'overlay', '-o',
                    f'index=off,lowerdir={bundle}/lower,upperdir={bundle}/upper,workdir={bundle}/work', str(bundle/'rootfs')], check=True)
    filesystem = bundle/'rootfs'
    if request['sharedSource']:
        (filesystem/'home/coder/project').mkdir()
    # Secrets, Pod DNS and the bootstrap are private files, never extra foreign
    # binds. The only external writable bind is canonical Project source.
    for name in (['slot.json'] if request['reserveSeed'] else ['assignment.json', 'parent-token', 'child-token']):
        value = Path('/factory/assignment', name).read_bytes()
        path = filesystem/'factory/assignment'/name
        path.write_bytes(value)
        path.chmod(0o400)
    certificate = Path('/factory/registry-ca/ca.crt').read_bytes()
    (filesystem/'factory/registry-ca/ca.crt').write_bytes(certificate)
    authority = request['runtimeHostImage'].split('/')[0]
    trust = filesystem/'etc/docker/certs.d'/authority
    trust.mkdir(parents=True, exist_ok=True)
    (trust/'ca.crt').write_bytes(certificate)
    for name in ['hosts', 'hostname', 'resolv.conf']:
        (filesystem/'etc'/name).write_bytes(Path('/etc', name).read_bytes())
    bootstrap = filesystem/'factory/bootstrap.sh'
    bootstrap.write_text(request['bootstrap'])
    bootstrap.chmod(0o500)
    subprocess.run(['/opt/factorybox/components/sysbox-runc', 'spec', '--bundle', str(bundle)], check=True)
    config = bundle/'config.json'
    spec = json.loads(config.read_text())
    spec['process'].update({'terminal': False, 'cwd': '/', 'user': {'uid': 0, 'gid': 0},
                            'args': ['/bin/sh', '-c', 'exec /bin/sh /factory/bootstrap.sh </dev/null >>/var/log/factory-connector.log 2>&1'],
                            'env': ['HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']})
    if request['reserveSeed']:
        spec['process']['env'].append('FACTORY_POD_UID='+request['podUID'])
    forbidden = {'CAP_SYS_MODULE', 'CAP_SYS_RAWIO', 'CAP_SYS_BOOT', 'CAP_SYS_TIME', 'CAP_SYSLOG'}
    for key, values in spec['process']['capabilities'].items():
        spec['process']['capabilities'][key] = [value for value in values if value not in forbidden]
    for key in ['bounding', 'effective', 'permitted']:
        spec['process']['capabilities'][key] = sorted(set(spec['process']['capabilities'][key]) | {'CAP_SYS_ADMIN', 'CAP_NET_ADMIN'})
    spec['root']['readonly'] = False
    spec['linux']['uidMappings'] = [{'containerID': 0, 'hostID': 100000, 'size': 65536}]
    spec['linux']['gidMappings'] = [{'containerID': 0, 'hostID': 100000, 'size': 65536}]
    # Go 1.27 enables MPTCP listeners by default. CRIU cannot retain those
    # sockets, so use ordinary TCP in this newly owned guest network namespace.
    # Kernels without MPTCP already use TCP and have no corresponding sysctl.
    if Path('/proc/sys/net/mptcp/enabled').exists():
        spec['linux'].setdefault('sysctl', {})['net.mptcp.enabled'] = '0'
    spec['linux']['resources'] = {'pids': {'limit': 384}, 'devices': [{'allow': True, 'access': 'rwm'}]}
    for mount in spec['mounts']:
        if mount['destination'] == '/sys/fs/cgroup':
            mount['options'] = ['nosuid', 'noexec', 'nodev', 'rw']
    annotations = spec.setdefault('annotations', {})
    annotations.update({'io.factorybox.base': 'factory-runtime', 'io.factorybox.outbound-ipv4': 'true',
                        'io.factorybox.checkpoint.irmap-scan-paths': json.dumps(['/home/coder/project'])})
    if request['sharedSource']:
        project = Path('/factory-source/project')
        info = project.lstat()
        if project.is_symlink() or not project.is_dir() or (info.st_uid, info.st_gid) != (101000, 101000):
            raise ValueError('Canonical Project source must retain the Source service identity')
        spec['mounts'].append({'type': 'bind', 'source': str(project), 'destination': '/home/coder/project',
                               'options': ['rbind', 'rw', 'rprivate', 'nosuid', 'nodev']})
        annotations['io.factorybox.shared-source'] = json.dumps({'source': str(project), 'destination': '/home/coder/project'})
    config.write_text(json.dumps(spec, separators=(',', ':'))+'\n')
    os.sync()
    mounts = input_mounts(bundle)
    if set(mounts) != {str(bundle/name) for name in ['rootfs', 'lower']}:
        raise ValueError('Prepared input mount pair is incomplete')
    publish(root/'mounts.json', mounts)
    completed = {'version': 2, 'sandboxID': request['sandboxID'], 'bundle': str(bundle), 'configSHA256': digest(config), 'rootfsSHA256': expected[0],
                 'storeID': request['storeID'], 'epoch': request['epoch'], 'podUID': request['podUID']}
    publish(root/'prepared.json', completed)
    return completed


def release(request, never_started):
    status = json.loads(subprocess.check_output(['/opt/factorybox/factorybox', 'worker-status'], timeout=10))
    root = Path(status['store'])/'input'/request['sandboxID']
    if not (root/'prepared.json').is_file():
        raise ValueError('Incomplete preparation must remain retained for inspection')
    prepared = prepare(request)
    cli = ['/opt/factorybox/factorybox', '--worker-run-root', '/run/factorybox',
           '--worker-store-id', prepared['storeID'], '--worker-epoch', prepared['epoch']]
    if never_started:
        if (Path(status['lifecycle']['root'])/'objects'/request['sandboxID']).exists():
            raise ValueError('Native runtime object exists despite never-started cleanup intent')
    else:
        state = json.loads(subprocess.check_output([*cli, 'state', request['sandboxID']], timeout=15))
        if state['record']['id'] != request['sandboxID'] or state['record']['phase'] != 'deleted':
            raise ValueError('Private input mounts can only release after confirmed native Delete')
    bundle = Path(prepared['bundle'])
    expected = json.loads((root/'mounts.json').read_text())
    receipt = root/'released.json'
    if receipt.exists():
        if json.loads(receipt.read_text()) != {'version': 1, 'mounts': expected} or input_mounts(bundle):
            raise ValueError('Released input mount ownership changed')
        return {'version': 1, 'released': True}
    current = input_mounts(bundle)
    if any(path not in expected or value != expected[path] for path, value in current.items()):
        raise ValueError('Private input mount identity changed; retain all backing')
    for name in ['rootfs', 'lower']:
        target = str(bundle/name)
        current = input_mounts(bundle)
        if target in current:
            if current[target] != expected[target]:
                raise ValueError('Private input mount changed before ordinary unmount')
            subprocess.run(['umount', '--', target], check=True, timeout=15)
    if input_mounts(bundle):
        raise ValueError('Owned input mounts remain after release')
    publish(receipt, {'version': 1, 'mounts': expected})
    return {'version': 1, 'released': True}


if __name__ == '__main__':
    encoded = sys.stdin.buffer.read(65537)
    if len(encoded) > 65536:
        raise ValueError('Factory preparation request exceeds 64 KiB')
    request = json.loads(encoded)
    if len(sys.argv) == 1:
        print(json.dumps(prepare(request)))
    elif sys.argv[1:] in [['release'], ['release', '--never-started']]:
        print(json.dumps(release(request, '--never-started' in sys.argv)))
    else:
        raise ValueError('Unknown Factory preparation operation')
