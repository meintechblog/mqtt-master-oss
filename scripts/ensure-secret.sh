#!/usr/bin/env bash
# ENCRYPTION_SECRET for stored passwords.
#
#   ensure-secret.sh anlegen <config.json> <secret-file>   (install.sh)
#   ensure-secret.sh pruefen <config.json> <secret-file>   (run-update.sh preflight)
#
# anlegen: creates the secret file (0600) once and never overwrites it. If
#   config.json already holds encrypted values, a new secret would not fit
#   them and the service would not start: exit 3, migrate by hand first.
# pruefen: exit 3 if the secret file is missing or has no ENCRYPTION_SECRET.
set -euo pipefail

MODE="${1:-}"
CONFIG="${2:-/opt/mqtt-master/config.json}"
SECRET_FILE="${3:-/etc/mqtt-master/env}"
GUIDE="README.md (section Encryption secret)"

has_secret() {
    [ -f "${SECRET_FILE}" ] && grep -Eq '^ENCRYPTION_SECRET=.+' "${SECRET_FILE}"
}

case "${MODE}" in
    anlegen)
        if has_secret; then
            echo "Encryption secret already exists (${SECRET_FILE})"
            exit 0
        fi
        if [ -f "${CONFIG}" ] && grep -Eq '"enc2?:' "${CONFIG}"; then
            echo "${CONFIG} holds encrypted values but ${SECRET_FILE} is missing." >&2
            echo "A new secret would not fit them. Migrate by hand first: ${GUIDE}" >&2
            exit 3
        fi
        install -d -m 700 "$(dirname "${SECRET_FILE}")"
        ( umask 077; printf 'ENCRYPTION_SECRET=%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" > "${SECRET_FILE}" )
        echo "Encryption secret created (${SECRET_FILE})"
        ;;
    pruefen)
        if ! has_secret; then
            echo "ENCRYPTION_SECRET missing in ${SECRET_FILE} - the service would not start. See ${GUIDE}" >&2
            exit 3
        fi
        ;;
    *)
        echo "usage: $0 anlegen|pruefen <config.json> <secret-file>" >&2
        exit 2
        ;;
esac
