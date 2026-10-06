"""File and pinned Git effects used by catalog command entrypoints."""
from pathlib import Path
import subprocess
import tempfile


def load_pinned_blobs(repo, pin, paths):
    return {path: subprocess.check_output(['git', '-C', str(repo), 'show', f'{pin}:{path}'])
            for path in paths}


def write_catalog(output, content, *, atomic=False, create_parent=False):
    output = Path(output)
    if create_parent:
        output.parent.mkdir(parents=True, exist_ok=True)
    if not atomic:
        output.write_text(content)
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=output.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
