# shellcheck source=common.sh
. /scripts/common.sh
load_set

# A raft snapshot needs a token that may read sys/storage/raft/snapshot. By default Factory
# creates a least-privilege AppRole for it and stores its login in the Secret
# <release>-backup-openbao, mounted at /openbao-login. backup.openbao.tokenSecret replaces that
# with an operator token at /openbao-token, which is renewed on every run.
login() {
  BAO_TOKEN="$(bao write -field=token auth/approle/login role_id=@/openbao-login/role-id secret_id=@/openbao-login/secret-id)" &&
    [ -n "$BAO_TOKEN" ]
}

snapshot() {
  if [ -s /openbao-token/token ]; then
    BAO_TOKEN="$(cat /openbao-token/token)"
    export BAO_TOKEN
    bao token renew > /dev/null || echo "The snapshot token could not be renewed" >&2
  else
    login || return 1
    export BAO_TOKEN
  fi
  rm -f "$DIR/openbao.snap.part"
  bao operator raft snapshot save "$DIR/openbao.snap.part" &&
    tar -tzf "$DIR/openbao.snap.part" > /tmp/snapshot.list &&
    grep -q '^meta.json$' /tmp/snapshot.list &&
    mv "$DIR/openbao.snap.part" "$DIR/openbao.snap"
}

# The unseal key, AppRole login and installation identity live only in the state claim, and a
# snapshot cannot be opened without that key.
state() {
  rm -f "$DIR/state.tar.gz.part"
  tar -C /state -czf "$DIR/state.tar.gz.part" --exclude=./kubernetes-ready.json --exclude=./bootstrap.lock . &&
    tar -tzf "$DIR/state.tar.gz.part" > /tmp/state.list &&
    grep -q 'openbao/bootstrap.json$' /tmp/state.list &&
    mv "$DIR/state.tar.gz.part" "$DIR/state.tar.gz"
}

step state state
if [ -s /openbao-token/token ] || [ -s /openbao-login/secret-id ]; then
  step openbao retry 3 snapshot
else
  echo "WARNING: no OpenBao snapshot credential exists yet. This set does not contain OpenBao data." >&2
  : > "$DIR/openbao.skipped"
fi
