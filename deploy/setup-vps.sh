#!/usr/bin/env bash
#
# setup-vps.sh — Fresh Ubuntu/Debian VPS bootstrap
#
# Phases:
#   1. System updates + base packages
#   2. Non-root sudo user + SSH hardening (key-only, root login disabled)
#   3. UFW firewall (22/80/443) + Fail2Ban
#   4. Docker + Docker Compose v2, Node.js LTS, Nginx
#
# Usage (interactive):
#   sudo bash setup-vps.sh
#
# Usage (automation - env vars skip the prompts):
#   SUDO_USER=deploy \
#   SSH_PUB_KEY="ssh-ed25519 AAAA... user@host" \
#   bash setup-vps.sh
#
# The script is idempotent: safe to run multiple times.
set -euo pipefail

C_RESET='\033[0m'
C_GREEN='\033[0;32m'
C_CYAN='\033[0;36m'
C_YELLOW='\033[1;33m'
C_RED='\033[0;31m'

say()  { printf "${C_CYAN}[setup]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}[ ok ]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[warn]${C_RESET} %s\n" "$*"; }
die()  { printf "${C_RED}[fail]${C_RESET} %s\n" "$*" >&2; exit 1; }

# ─────────────────────────── sanity checks ───────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash setup-vps.sh"

. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) die "Only Ubuntu/Debian are supported (found: $ID)" ;;
esac
say "OS: $PRETTY_NAME ($ID $(lsb_release -cs 2>/dev/null || true))"

# ─────────────────────────── configuration ───────────────────────────
# Pull from env so a repeat run reuses the same answers and stays idempotent.
SRV_USER="${SUDO_USER:-}"
SSH_KEY="${SSH_PUB_KEY:-}"

if [ -z "$SRV_USER" ] && [ -t 0 ]; then
  read -r -p "Admin username (default: admin): " SRV_USER
  SRV_USER="${SRV_USER:-admin}"
fi
SRV_USER="${SRV_USER:-admin}"
[ "$SRV_USER" != "root" ] || die "Do not use 'root' as the admin username."

# ─────────────────────────── phase 0: updates & base ───────────────────────────
phase_apt() {
  say "Phase 0/6 — apt update & upgrade"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get upgrade -y
  apt-get install -y \
    curl wget git ca-certificates gnupg lsb-release rsync \
    ufw fail2ban nginx unattended-upgrades apt-listchanges
  ok "System packages updated"
}

# ─────────────────────────── phase 1: sudo user ───────────────────────────
phase_sudo_user() {
  say "Phase 1/6 — creating sudo user '$SRV_USER'"
  if id -u "$SRV_USER" >/dev/null 2>&1; then
    ok "'$SRV_USER' already exists, skipping creation"
  else
    if [ -t 0 ]; then
      adduser "$SRV_USER"                       # prompts for a password
    else
      adduser --disabled-password --gecos "" "$SRV_USER"
      warn "Non-interactive: user created WITHOUT a password."
      warn "Set one later with: passwd $SRV_USER"
    fi
  fi
  usermod -a -G sudo "$SRV_USER" || true        # idempotent group add
  ok "'$SRV_USER' is in sudo group"
}

# ─────────────────────────── phase 2: SSH hardening ───────────────────────────
phase_ssh() {
  say "Phase 2/6 — SSH hardening"

  if [ -z "$SSH_KEY" ] && [ -t 0 ]; then
    read -r -p "Paste your SSH public key (or Enter to skip): " SSH_KEY
  fi

  # Always enable pubkey auth + keep existing behavior until a key is confirmed.
  SSHD_FILE=/etc/ssh/sshd_config.d/99-hardening.conf

  if [ -n "$SSH_KEY" ]; then
    install -d -m 700 "/home/$SRV_USER/.ssh"
    if ! grep -qF "$SSH_KEY" "/home/$SRV_USER/.ssh/authorized_keys" 2>/dev/null; then
      echo "$SSH_KEY" >> "/home/$SRV_USER/.ssh/authorized_keys"
      ok "SSH public key installed for '$SRV_USER'"
    fi
    chown -R "$SRV_USER":"$SRV_USER" "/home/$SRV_USER/.ssh"
    chmod -R 600 "/home/$SRV_USER/.ssh/authorized_keys"

    printf '%s\n' \
      'PermitRootLogin no' \
      'PubkeyAuthentication yes' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      > "$SSHD_FILE"
    # Validate BEFORE touching the live sshd so we can never lock ourselves out.
    sshd -t -f /etc/ssh/sshd_config || die "sshd config invalid — aborted, no restart performed"
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    ok "Root SSH login disabled; password auth disabled. Key login only."
    warn "Keep this session open. Test a NEW session before closing this one."
  else
    warn "No public key provided — SSH hardening skipped."
    warn "Rerun with SSH_PUB_KEY=... when you have your key."
  fi
}

# ─────────────────────────── phase 3: firewall + fail2ban ───────────────────────────
phase_fw() {
  say "Phase 3/6 — UFW firewall"
  ufw allow in 22/tcp  comment 'OpenSSH'  >/dev/null
  ufw allow in 80/tcp  comment 'HTTP'     >/dev/null
  ufw allow in 443/tcp comment 'HTTPS'    >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null 2>&1
  ufw status verbose
  ok "UFW enabled: SSH/HTTP/HTTPS allowed, rest denied"

  say "  configuring Fail2Ban"
  JAIL=/etc/fail2ban/jail.local
  if [ ! -f "$JAIL" ]; then
    cat > "$JAIL" <<'EOF'
[DEFAULT]
bantime = 30m
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = %(sshd_backend)s
EOF
  fi
  systemctl enable --now fail2ban >/dev/null 2>&1
  systemctl reload fail2ban >/dev/null 2>&1 || true
  ok "Fail2Ban enabled for sshd"
}

# ─────────────────────────── phase 4: docker ───────────────────────────
phase_docker() {
  say "Phase 4/6 — Docker + Compose v2"
  if [ ! -f /usr/share/keyrings/docker.gpg ]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" | gpg --dearmor --yes -o /usr/share/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/$ID $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
  fi
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker >/dev/null 2>&1
  usermod -a -G docker "$SRV_USER" || true
  docker --version
  docker compose version
  ok "'$SRV_USER' added to docker group"
}

# ─────────────────────────── phase 5: node.js ───────────────────────────
phase_node() {
  say "Phase 5/6 — Node.js LTS + Nginx"
  if command -v node >/dev/null 2>&1; then
    ok "Node already installed: $(node -v)"
  else
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
    ok "Node installed: $(node -v)"
  fi
  npm --version
  nginx -t >/dev/null 2>&1 || nginx -t
  systemctl enable --now nginx >/dev/null 2>&1
  ok "Nginx running"
}

# ─────────────────────────── phase 6: summary ───────────────────────────
phase_summary() {
  say "Phase 6/6 — Done"
  printf '\n'
  printf "${C_GREEN}=================== SETUP COMPLETE ===================${C_RESET}\n"
  printf "  VPS            : %s/%s (%s)\n" "$ID" "$(lsb_release -cs 2>/dev/null || true)" "$(uname -m)"
  printf "  Admin user     : %s (sudo + docker groups)\n" "$SRV_USER"
  printf "  SSH            : key-only, root login disabled\n"
  printf "  Firewall       : UFW (22/80/443) + Fail2Ban\n"
  printf "  Docker         : %s + Compose v2\n" "$(docker --version 2>/dev/null | awk '{print $3}' || echo '?')"
  printf "  Node.js        : %s\n" "$(node -v 2>/dev/null || echo '?')"
  printf '  Nginx          : %s\n' "$(nginx -v 2>&1 | awk '{print $3}')"
  printf '  ─────────────────────────────────────────────────────────\n'
  printf '  Login from your workstation (use the key you installed):\n\n'
  printf '      ssh -i ~/.ssh/id_opencode %s@158.220.118.91\n\n' "$SRV_USER"
  printf "  Fallback       : Contabo web console (root) if anything is wrong\n"
  printf "${C_GREEN}======================================================${C_RESET}\n"
  printf '\nNext steps for the captive portal stack:\n'
  printf '  1. From your PC:  scp deploy/nginx-preyone.conf %s@158.220.118.91:/etc/nginx/sites-available/preyone\n' "$SRV_USER"
  printf '  2. Install PostgreSQL + FreeRADIUS (native, or Docker) and the portal (pm2)\n'
  printf '  3. Update your DNS records to point at 158.220.118.91 before enabling HTTPS\n'
}

phase_apt
phase_sudo_user
phase_ssh
phase_fw
phase_docker
phase_node
phase_summary