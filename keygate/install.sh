#!/usr/bin/env bash
# One-shot install of ccflare (this fork) + keygate on a fresh Ubuntu box. Run as root.
#   curl -fsSL https://raw.githubusercontent.com/samyares/ccflare/main/keygate/install.sh | bash
# Idempotent: safe to re-run to update code.
# On a host that already runs other services, set SKIP_FIREWALL=1 (the ufw step resets all rules).
set -euo pipefail
REPO="${REPO:-https://github.com/samyares/ccflare.git}"
CCFLARE_DIR=/root/ccflare
KG_DIR=/root/keygate
export DEBIAN_FRONTEND=noninteractive PATH="/root/.bun/bin:$PATH"

[ "$(id -u)" = 0 ] || { echo "run as root (sudo -i)"; exit 1; }

echo "== packages"
apt-get update -qq && apt-get install -y -qq git curl unzip sqlite3 ufw >/dev/null

echo "== swap (2G) if missing"
if ! swapon --show --noheadings | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  sysctl -w vm.swappiness=20 >/dev/null; grep -q vm.swappiness /etc/sysctl.conf || echo "vm.swappiness=20" >> /etc/sysctl.conf
fi

echo "== bun"
[ -x /root/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash >/dev/null
bun --version

echo "== ccflare source"
if [ -d "$CCFLARE_DIR/.git" ]; then git -C "$CCFLARE_DIR" pull -q --ff-only; else git clone -q "$REPO" "$CCFLARE_DIR"; fi
git -C "$CCFLARE_DIR" remote get-url upstream >/dev/null 2>&1 || git -C "$CCFLARE_DIR" remote add upstream https://github.com/snipeship/ccflare.git
cd "$CCFLARE_DIR" && bun install --silent && bun run build >/dev/null

echo "== keygate files"
mkdir -p "$KG_DIR"
cp keygate/gateway.ts keygate/dashboard.html "$KG_DIR/"
if [ ! -f "$KG_DIR/.env" ]; then
  cat > "$KG_DIR/.env" <<ENV
ADMIN_KEY=sk-admin-$(openssl rand -hex 16)
GATE_PORT=4000
ADMIN_PORT=8081
UPSTREAM=http://127.0.0.1:8080
KEYS_FILE=$KG_DIR/keys.json
CCFLARE_DB=/root/.config/ccflare/ccflare.db
ENV
  chmod 600 "$KG_DIR/.env"
fi
[ -f "$KG_DIR/keys.json" ] || { echo '{}' > "$KG_DIR/keys.json"; chmod 600 "$KG_DIR/keys.json"; }

echo "== systemd"
cp keygate/ccflare.service keygate/keygate.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ccflare keygate >/dev/null 2>&1
systemctl restart ccflare keygate

if [ "${SKIP_FIREWALL:-0}" = 1 ]; then
  echo "== firewall: skipped (SKIP_FIREWALL=1). Make sure port 8080 is not reachable from the internet."
else
  echo "== firewall (ufw): allow ssh/4000/8081, deny the rest"
  SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}'); SSH_PORT=${SSH_PORT:-22}
  ufw --force reset >/dev/null; ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw allow "${SSH_PORT}/tcp" >/dev/null; ufw allow 4000/tcp >/dev/null; ufw allow 8081/tcp >/dev/null
  ufw --force enable >/dev/null
fi

sleep 4
echo "== health"
curl -sf http://127.0.0.1:8080/health >/dev/null && echo "ccflare ok" || { echo "ccflare NOT healthy"; journalctl -u ccflare -n 20 --no-pager; exit 1; }
curl -sf http://127.0.0.1:4000/health >/dev/null && echo "keygate ok" || { echo "keygate NOT healthy"; journalctl -u keygate -n 20 --no-pager; exit 1; }

cat <<MSG

Done. Next steps:
  1. Add a Claude account (interactive, opens an OAuth URL to paste a code):
       cd $CCFLARE_DIR && bun run ccflare --add-account work --provider claude-code
  2. Admin key (dashboards):  $(grep ADMIN_KEY "$KG_DIR/.env" | cut -d= -f2)
       usage + users:  http://<this-ip>:4000/dashboard
       ccflare UI:     http://<this-ip>:8081   (basic auth, any user, password = admin key)
  3. Create user keys in the dashboard, or copy keys.json from another keygate host.
MSG
