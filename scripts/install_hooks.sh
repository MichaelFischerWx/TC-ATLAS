#!/bin/sh
# Install the repo's tracked git hooks (scripts/hooks/) for this clone.
#
# Writes a small shim into the shared hooks directory instead of pointing
# core.hooksPath at scripts/hooks: every worktree then runs the hook from its
# OWN checkout, so a branch that predates a hook is unaffected and a branch
# that changes a hook tests its own version. Safe to re-run.
set -e
dir=$(git config core.hooksPath || true)
[ -n "$dir" ] || dir="$(git rev-parse --git-common-dir)/hooks"
mkdir -p "$dir"
for name in pre-commit; do
    dst="$dir/$name"
    if [ -e "$dst" ] && ! grep -q 'tc-atlas tracked-hook shim' "$dst"; then
        echo "install_hooks: $dst exists and is not ours; leaving it alone." >&2
        continue
    fi
    cat > "$dst" <<SHIM
#!/bin/sh
# tc-atlas tracked-hook shim (scripts/install_hooks.sh). Runs this checkout's
# scripts/hooks/$name; does nothing in a checkout that doesn't have it.
hook="\$(git rev-parse --show-toplevel)/scripts/hooks/$name"
[ -f "\$hook" ] || exit 0
exec sh "\$hook" "\$@"
SHIM
    chmod +x "$dst"
    echo "install_hooks: $dst -> scripts/hooks/$name"
done
