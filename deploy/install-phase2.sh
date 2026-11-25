#!/usr/bin/env bash
# Root installer. Bootstrap password is read from stdin, never an argument or log.
set -euo pipefail
umask 077
sha=${1:?commit required}
archive=${2:?private package required}
names=${3:-}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $archive == /var/tmp/qqsg-deploy-$sha.*/package.tar.gz ]] || exit 2
exec 9>/run/lock/qqsg-fighting-deploy.lock
flock -n 9 || { echo 'Another deployment is running'; exit 2; }
base=/var/www/qqsg-fighting
data=/var/lib/qqsg-fighting
snippet=/etc/nginx/snippets/qqsg-fighting.conf
unit=/etc/systemd/system/qqsg-fighting.service
release=$base/releases/$sha
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$base/backups/phase2-$stamp-$sha
mkdir -p "$backup" "$base/releases" "$base/shared/assets"
chmod 700 "$backup"
old=$(readlink "$base/current" || true)
[[ -n $old && -d $base/current ]] || { echo 'Missing existing release'; exit 2; }
cp -a "$snippet" "$backup/nginx.conf"
had_unit=0; was_active=0; was_enabled=0
if [[ -f $unit ]]; then had_unit=1; cp -a "$unit" "$backup/service.unit"; fi
systemctl is-active --quiet qqsg-fighting && was_active=1 || true
systemctl is-enabled --quiet qqsg-fighting 2>/dev/null && was_enabled=1 || true
if [[ $was_active == 0 ]] && ss -ltnH '( sport = :8780 )' | grep -q .; then echo 'Port 8780 is occupied; refusing to touch unrelated process'; exit 2; fi
rollback() {
    local failure=${1:-1}
    [[ $failure != 0 ]] || failure=1
    trap - ERR
    set +e
    systemctl stop qqsg-fighting
    if [[ $was_enabled == 0 ]]; then systemctl disable qqsg-fighting 2>/dev/null; fi
    if [[ -f $backup/bridge.conf ]]; then
        cp -a "$backup/bridge.conf" "$snippet"
        if ! nginx -t || ! systemctl reload nginx; then
            echo 'Could not activate rollback bridge; current kept unchanged for manual recovery' >&2
            exit "$failure"
        fi
    else
        cp -a "$backup/nginx.conf" "$snippet"
    fi
    ln -sfn "$old" "$base/current.rollback"
    mv -Tf "$base/current.rollback" "$base/current"
    if [[ $had_unit == 1 ]]; then cp -a "$backup/service.unit" "$unit"; else rm -f "$unit"; fi
    systemctl daemon-reload
    if [[ $was_enabled == 1 ]]; then systemctl enable qqsg-fighting; fi
    if [[ $was_active == 1 ]]; then systemctl start qqsg-fighting; fi
    nginx -t && systemctl reload nginx
    echo "Deployment failed; previous code/config restored. Data retained. Backup: $backup" >&2
    exit "$failure"
}
trap 'rollback $?' ERR
nginx -t
getent passwd qqsg-fighting >/dev/null || useradd --system --home-dir "$data" --shell /usr/sbin/nologin qqsg-fighting
install -d -m 700 -o qqsg-fighting -g qqsg-fighting "$data" "$data/backups"
chmod 755 "$base/shared" "$base/shared/assets"
digest=$(sha256sum "$archive" | cut -d' ' -f1)
if [[ -d $release ]]; then
    [[ $(cat "$release/.package-sha256") == "$digest" ]]
else
    incoming=$(mktemp -d "$base/releases/.incoming-$sha.XXXXXX")
    python3 - "$archive" <<'PY'
import sys,tarfile
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        p=m.name.removeprefix('./')
        if p in ('','.') and m.isdir(): continue
        if p.startswith('/') or '..' in p.split('/') or not (m.isfile() or m.isdir()): raise SystemExit('Unsafe package entry')
        if p.split('/')[0] not in ('web','bin','deploy'): raise SystemExit('Unexpected package entry')
PY
    tar --no-same-owner -xzf "$archive" -C "$incoming"
    test -f "$incoming/web/index.html"
    test -f "$incoming/web/admin/index.html"
    test -x "$incoming/bin/qqsg-server" || chmod 755 "$incoming/bin/qqsg-server"
    python3 - "$incoming" "$sha" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); b=(p/'bin/qqsg-server').read_bytes()[:20]
if b[:4]!=b'\x7fELF' or b[4]!=2 or b[18:20]!=b'\x3e\x00': raise SystemExit('Expected Linux amd64 binary')
if json.loads((p/'web/version.json').read_text())['commit']!=sys.argv[2]: raise SystemExit('Version mismatch')
m=json.loads((p/'web/models/model.json').read_text())
if not m['url'].startswith('https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/'): raise SystemExit('Unexpected model source')
if list((p/'web').rglob('*.onnx')): raise SystemExit('Model weights must not be deployed')
PY
    printf '%s\n' "$digest" > "$incoming/.package-sha256"
    chmod -R a+rX "$incoming"
    mv "$incoming" "$release"
fi
oldweb=$base/current
[[ ! -d $oldweb/web ]] || oldweb=$oldweb/web
oldweb=$(readlink -f "$oldweb")
[[ $oldweb == "$base/releases/"* ]] || { echo 'Existing web root is outside release directory'; false; }
# Already-open tabs may load non-hashed runtime/model URLs after the switch.
python3 - "$oldweb" "$release/web" "$base/shared/assets" <<'PY'
from pathlib import Path
import shutil,sys
old,new,shared=map(Path,sys.argv[1:])
for folder in ('vendor','models'):
    if not (old/folder).exists(): continue
    for src in (old/folder).rglob('*'):
        if src.is_file():
            dst=new/src.relative_to(old)
            if not dst.is_file() or src.read_bytes()!=dst.read_bytes(): raise SystemExit('Old runtime/model resource incompatibility: '+str(src.relative_to(old)))
for root in (old/'assets',new/'assets'):
    if not root.exists(): continue
    for src in root.rglob('*'):
        if not src.is_file(): continue
        dst=shared/src.relative_to(root); dst.parent.mkdir(parents=True,exist_ok=True)
        if dst.exists() and src.read_bytes()!=dst.read_bytes(): raise SystemExit('Hashed asset collision')
        if not dst.exists(): shutil.copyfile(src,dst)
        dst.chmod(0o644)
shared.chmod(0o755)
for directory in shared.rglob('*'):
    if directory.is_dir(): directory.chmod(0o755)
PY
admin_count=0
if [[ -f $data/db/fighting.db ]]; then
    runuser -u qqsg-fighting -- python3 - "$data/db/fighting.db" "$data/backups/pre-$stamp.db" <<'PY'
import sqlite3,sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True) as src, sqlite3.connect(sys.argv[2]) as dst: src.backup(dst)
PY
    admin_count=$(runuser -u qqsg-fighting -- python3 - "$data/db/fighting.db" <<'PY'
import sqlite3,sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True) as db: print(db.execute('SELECT COUNT(*) FROM admins').fetchone()[0])
PY
)
fi
if [[ $admin_count == 0 ]]; then
    IFS= read -r bootstrap_password
    bootstrap_password=${bootstrap_password%$'\r'}
    [[ ${#bootstrap_password} -ge 12 ]]
    printf '%s\n' "$bootstrap_password" | runuser -u qqsg-fighting -- bash -c 'IFS= read -r QQSG_ADMIN_PASSWORD; export QQSG_ADMIN_PASSWORD; exec "$1" --data-dir "$2" --init-admin' _ "$release/bin/qqsg-server" "$data"
    unset bootstrap_password
fi
if [[ -n $names ]]; then
    [[ $names == /var/tmp/qqsg-deploy-$sha.*/names.tar.gz ]]
    nameinput=$data/names/import-$stamp
    install -d -m 700 -o qqsg-fighting -g qqsg-fighting "$nameinput"
    python3 - "$names" "$nameinput" <<'PY'
import sys,tarfile
from pathlib import Path
allowed={'name_a.txt','name_b.txt','name_others.txt','aliases.tsv','blacklist.txt'}
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        name=m.name.removeprefix('./')
        if name in ('','.') and m.isdir(): continue
        if name not in allowed or not m.isfile(): raise SystemExit('Unsafe name archive')
        (Path(sys.argv[2])/name).write_bytes(t.extractfile(m).read())
PY
    chown -R qqsg-fighting:qqsg-fighting "$nameinput"
    chmod 600 "$nameinput"/*
    runuser -u qqsg-fighting -- "$release/bin/qqsg-server" --data-dir "$data" --import-names "$nameinput"
fi
install -m 644 "$release/deploy/qqsg-fighting.service" "$unit"
# Bridge the layout migration: old nginx must never serve new current/bin as static files.
python3 - "$release/deploy/nginx-phase2.conf" "$backup/bridge.conf" "$oldweb" <<'PY'
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
Path(sys.argv[2]).write_text(source.replace('/var/www/qqsg-fighting/current/web/',sys.argv[3]+'/'))
PY
install -m 644 "$backup/bridge.conf" "$snippet"
nginx -t
systemctl reload nginx
ln -sfn "releases/$sha" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
systemctl daemon-reload
systemctl enable qqsg-fighting
systemctl restart qqsg-fighting
healthy=0
for attempt in $(seq 1 30); do
    code=$(curl --connect-timeout 2 --max-time 4 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8780/fighting/api/v1/admin/session || true)
    if [[ $code == 401 ]]; then healthy=1; break; fi
    sleep 1
done
[[ $healthy == 1 ]]
systemctl is-active --quiet qqsg-fighting
install -m 644 "$release/deploy/nginx-phase2.conf" "$snippet"
nginx -t
systemctl reload nginx
[[ $(curl --connect-timeout 2 --max-time 5 -sS --resolve jinbaofu.cn:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://jinbaofu.cn/fighting/api/v1/admin/stats) == 401 ]]
curl --connect-timeout 2 --max-time 5 -fsS --resolve jinbaofu.cn:443:127.0.0.1 https://jinbaofu.cn/fighting/version.json | python3 -c 'import json,sys;assert json.load(sys.stdin)["commit"]==sys.argv[1]' "$sha"
printf 'commit=%s\nprevious=%s\nbackup=%s\nhad_unit=%s\nwas_active=%s\nwas_enabled=%s\n' "$sha" "$old" "$backup" "$had_unit" "$was_active" "$was_enabled" > "$release/deployment.txt"
trap - ERR
echo "Deployed $sha. Previous: $old. Backup: $backup"
