"""Check the original worker PVC once before native filesystem creation."""
import json
import os
from pathlib import Path
import re
import stat


# The pinned Factorybox storefs contract checks this floor again when allocating.
# A PVC's declared capacity is not proof of available backing filesystem space.
HOST_FREE_FLOOR = 12 * 1024 ** 3
HOST_WRITE_RESERVE = 4 * 1024 ** 3


def required_capacity(bounded_bytes):
    if (type(bounded_bytes) is not int or
            bounded_bytes < 8 * 1024 ** 3 or bounded_bytes > 32 * 1024 ** 3 or
            bounded_bytes % (1024 ** 3)):
        raise ValueError('Storage admission requires the exact bounded worker capacity')
    return bounded_bytes + HOST_FREE_FLOOR + HOST_WRITE_RESERVE


def inspect_capacity(root, descriptor, pod_uid, store_id, required_bytes):
    opened = os.fstat(descriptor)
    current = root.lstat()
    if (not stat.S_ISDIR(opened.st_mode) or opened.st_uid != 0 or opened.st_gid != 0 or
            stat.S_IMODE(opened.st_mode) != 0o700 or
            (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
        raise ValueError('Storage admission requires the original private worker volume')
    receipt = os.open('.factory-initialized.json', os.O_RDONLY | os.O_NOFOLLOW,
                      dir_fd=descriptor)
    with os.fdopen(receipt, 'r') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 1024):
            raise ValueError('Worker volume initialization receipt is foreign')
        expected = {'version': 1, 'podUID': pod_uid, 'storeID': store_id}
        if json.load(stream) != expected:
            raise ValueError('Storage admission belongs to another original Pod or store')
    try:
        os.stat('fixed-store', dir_fd=descriptor, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        # This init container runs only before the original native worker.
        # Existing native state needs its own admission, not a bypass of this check.
        raise ValueError('Native worker storage already exists; refusing fresh admission')
    filesystem = os.fstatvfs(descriptor)
    block_size = filesystem.f_frsize or filesystem.f_bsize
    if block_size <= 0 or not 0 <= filesystem.f_bavail <= filesystem.f_blocks:
        raise ValueError('Backing filesystem capacity is unavailable')
    available = filesystem.f_bavail * block_size
    return {
        'version': 1,
        'state': 'ready' if available >= required_bytes else 'insufficient-storage',
        'availableBytes': available,
        'requiredBytes': required_bytes,
        'hostFreeFloorBytes': HOST_FREE_FLOOR,
        'hostWriteReserveBytes': HOST_WRITE_RESERVE,
    }


def admit_capacity(root, pod_uid, store_id, bounded_bytes, observe=print):
    required = required_capacity(bounded_bytes)
    if (not pod_uid or not re.fullmatch('[a-f0-9]{32}', store_id or '') or
            store_id == '0' * 32 or not root.is_absolute()):
        raise ValueError('Storage admission needs its exact Pod, store and mounted volume')
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        observation = inspect_capacity(root, descriptor, pod_uid, store_id, required)
        observe(json.dumps(observation))
        if observation['state'] != 'ready':
            raise RuntimeError(
                'Worker admission has insufficient backing storage: '
                f'{observation["availableBytes"]} bytes available, {required} required. '
                'Reclaim eligible owned storage or provide sufficient capacity '
                'before commissioning another execution. Waiting does not reclaim storage.')
        return observation
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    admit_capacity(Path('/factory-store'), os.environ.get('FACTORY_POD_UID'),
                   os.environ.get('FACTORY_STORE_ID'),
                   int(os.environ.get('FACTORY_BOUNDED_BYTES', '0')),
                   observe=lambda value: print(value, flush=True))
