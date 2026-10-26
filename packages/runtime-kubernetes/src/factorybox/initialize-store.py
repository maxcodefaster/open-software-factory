"""Initialize only a new, empty, uniquely owned Kubernetes worker PVC."""
import json
import os
from pathlib import Path
import re
import stat


def initialize(root, pod_uid, store_id):
    if not pod_uid or not re.fullmatch('[a-f0-9]{32}', store_id):
        raise ValueError('Store initialization needs its exact Pod and store identity')
    expected = {'version': 1, 'podUID': pod_uid, 'storeID': store_id}
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0:
        raise ValueError('New worker volume must be an original root-owned directory')
    receipt = root/'.factory-initialized.json'
    if receipt.exists():
        mode = receipt.lstat()
        if not stat.S_ISREG(mode.st_mode) or mode.st_uid != 0 or stat.S_IMODE(mode.st_mode) != 0o600 or mode.st_nlink != 1:
            raise ValueError('Store initialization receipt is foreign')
        if json.loads(receipt.read_text()) != expected or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Worker store belongs to another original Pod')
        return expected
    # Kubelet may prepare the next init container's empty subPath before this
    # command. It grants no permission to touch exported images or a real store.
    for path in root.iterdir():
        child = path.lstat()
        if path.name not in {'seed', 'lost+found'} or not stat.S_ISDIR(child.st_mode) or child.st_uid != 0 or child.st_gid != 0 or list(path.iterdir()):
            raise ValueError('Nonempty or unrecognized worker volume must remain untouched')
    root.chmod(0o700)
    seed = root/'seed'
    seed.mkdir(mode=0o700, exist_ok=True)
    seed.chmod(0o700)
    descriptor = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(expected, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return expected


if __name__ == '__main__':
    print(json.dumps(initialize(Path('/factory-store'), os.environ.get('FACTORY_POD_UID'), os.environ.get('FACTORY_STORE_ID'))))
