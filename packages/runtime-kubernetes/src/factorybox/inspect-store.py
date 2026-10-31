"""Inspect a retained store read-only before its explicitly commissioned successor."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat


def directory(path):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
            stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('Retained store directory identity changed')


def regular(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise ValueError('Retained store file identity changed')
    return info


def inspect(root, original_pod_uid, store_id, expected_bytes):
    if (not original_pod_uid or not re.fullmatch('[a-f0-9]{32}', store_id) or
            type(expected_bytes) is not int or expected_bytes <= 0):
        raise ValueError('Retained store needs its original initialization and capacity')
    directory(root)
    receipt = root/'.factory-initialized.json'
    regular(receipt)
    if json.loads(receipt.read_text()) != {
            'version': 1, 'podUID': original_pod_uid, 'storeID': store_id}:
        raise ValueError('Retained store belongs to another original Pod')
    bounded = root/'fixed-store'
    directory(bounded)
    record = bounded/'bounded.json'
    regular(record)
    identity = json.loads(record.read_text())
    image = regular(bounded/'store.img')
    recorded = identity.get('image', {})
    if (identity.get('schema') != 1 or recorded.get('schema') != 1 or
            recorded.get('owner') != store_id or recorded.get('bytes') != expected_bytes or
            recorded.get('path') != '/var/lib/sysbox/fixed-store/store.img' or
            (recorded.get('device'), recorded.get('inode'), recorded.get('bytes')) !=
            (image.st_dev, image.st_ino, image.st_size)):
        raise ValueError('Retained bounded store image or capacity changed')
    regular(bounded/'.worker.lock')
    descriptor = os.open(bounded/'.worker.lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(descriptor)
    return {'version': 1, 'storeID': store_id, 'boundedBytes': expected_bytes}


if __name__ == '__main__':
    print(json.dumps(inspect(
        Path('/factory-store'), os.environ['FACTORY_STORE_INITIALIZER_POD_UID'],
        os.environ['FACTORY_STORE_ID'], int(os.environ['FACTORY_RETAINED_STORE_BYTES']))))
