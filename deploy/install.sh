#!/usr/bin/env bash
# Run as root: bash install.sh COMMIT_SHA /tmp/qqsg-SHA.tar.gz
set -euo pipefail
sha=${1:?commit required}
archive=${2:?archive required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit'; exit 1; }
base=/var/www/qqsg-fighting
config=/etc/nginx/sites-available/vaultwarden
stamp=$(date -u +%Y%m%dT%H%M%SZ)
snippet=/etc/nginx/snippets/qqsg-fighting.conf
test ! -f "$base/releases/$sha/index.html" || { echo 'Release exists; refusing to overwrite immutable version'; exit 1; }
mkdir -p "$base/releases/$sha" "$base/backups"
cp -a "$config" "$base/backups/nginx-$stamp.conf"
had_snippet=0
if [ -f "$snippet" ]; then had_snippet=1; cp -a "$snippet" "$base/backups/snippet-$stamp.conf"; fi
old=$(readlink "$base/current" || true)
rollback() {
    trap - ERR
    cp -a "$base/backups/nginx-$stamp.conf" "$config"
    if [ "$had_snippet" = 1 ]; then cp -a "$base/backups/snippet-$stamp.conf" "$snippet"; else rm -f "$snippet"; fi
    if [ -n "$old" ]; then ln -sfn "$old" "$base/current"; elif [ -L "$base/current" ]; then rm "$base/current"; fi
}
trap rollback ERR
tar -xzf "$archive" -C "$base/releases/$sha"
test -f "$base/releases/$sha/index.html"
test -f "$base/releases/$sha/models/PP-OCRv6_rec_medium.onnx"
install -m 644 "$base/releases/$sha/deploy-location.conf" /etc/nginx/snippets/qqsg-fighting.conf
python3 - "$config" <<'PY'
import sys
from pathlib import Path
p=Path(sys.argv[1]); text=p.read_text()
line='    include /etc/nginx/snippets/qqsg-fighting.conf;'
if line not in text:
    marker='    location / {'
    if text.count(marker)!=1 or 'listen 443 ssl;' not in text:
        raise SystemExit('Unexpected nginx config; refusing to patch')
    text=text.replace(marker,line+'\n\n'+marker,1)
    p.write_text(text)
PY
if ! nginx -t; then
    rollback
    echo 'Nginx validation failed; config restored'; exit 1
fi
ln -sfn "releases/$sha" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
if ! systemctl reload nginx; then
    rollback
    nginx -t && systemctl reload nginx
    echo 'Reload failed; rollback attempted'; exit 1
fi
printf 'commit=%s\nprevious=%s\nnginx_backup=%s\n' "$sha" "$old" "$base/backups/nginx-$stamp.conf" | tee "$base/releases/$sha/deployment.txt"
echo 'https://jinbaofu.cn/fighting/'
