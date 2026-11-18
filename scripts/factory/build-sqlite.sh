#!/bin/sh
set -eu

source=$1
sha256=$2
output=$3
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
wget -q -O "$temporary/source.tar.gz" "$source"
printf '%s  %s\n' "$sha256" "$temporary/source.tar.gz" | sha256sum -c -
tar -xzf "$temporary/source.tar.gz" -C "$temporary"
set -- "$temporary"/sqlite-autoconf-*
test "$#" -eq 1
cd "$1"
# The receiving Forgejo Pod is musl-based, while Factory is glibc-based.
# A static CLI works in either without installing packages in a live installation.
cc -O2 -static -s -DSQLITE_THREADSAFE=1 -DSQLITE_DQS=0 \
  -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DEFAULT_FOREIGN_KEYS=1 \
  -DSQLITE_ENABLE_FTS5 -o "$output" shell.c sqlite3.c -lpthread -ldl -lm
"$output" -init /dev/null -batch -bail :memory: "SELECT sqlite_version();"
