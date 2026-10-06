"""AST-based Python dependency/effect check; parsing never imports project tools."""
import ast
import json
from pathlib import Path, PurePosixPath
import sys

PURE_LIBRARIES = {"__future__", "base64", "binascii", "collections", "csv", "dataclasses", "enum", "hashlib", "io", "itertools", "json", "math", "re", "stat", "struct", "typing", "zlib"}
EFFECT_CALLS = {"open", "print", "input", "exec", "eval", "__import__", "breakpoint"}


def check_module(name, source, roles):
    errors = []
    tree = ast.parse(source, filename=name)
    memory_modules = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for module in modules:
                if module == "io":
                    if isinstance(node, ast.ImportFrom):
                        if not all(alias.name in {"StringIO", "BytesIO"} for alias in node.names):
                            errors.append(f"{name}:{node.lineno}: logic imports external io operation")
                    else:
                        memory_modules.update(alias.asname or alias.name for alias in node.names if alias.name == "io")
                if module == "json" and isinstance(node, ast.ImportFrom) and any(alias.name == "dump" for alias in node.names):
                    errors.append(f"{name}:{node.lineno}: logic imports stream output")
                # Bare Python imports resolve beside the importing script. Keep that
                # ownership when tools are grouped into module folders.
                owner = str(PurePosixPath(name).parent / (module.replace(".", "/") + ".py"))
                root_peer = "scripts/" + module.replace(".", "/") + ".py"
                peer = owner if owner in roles else root_peer
                if peer in roles:
                    if roles[peer] != "logic":
                        errors.append(f"{name}:{node.lineno}: logic imports {roles[peer]} {peer}")
                elif module == "zipfile" and isinstance(node, ast.ImportFrom) and all(alias.name in {"ZIP_STORED", "ZIP_DEFLATED"} for alias in node.names):
                    pass
                elif module == "pathlib" and isinstance(node, ast.ImportFrom) and all(alias.name in {"PurePath", "PurePosixPath", "PureWindowsPath"} for alias in node.names):
                    pass
                elif module.split(".")[0] not in PURE_LIBRARIES:
                    errors.append(f"{name}:{node.lineno}: logic imports effect-capable package {module}")
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in EFFECT_CALLS:
            errors.append(f"{name}:{node.lineno}: logic references effect {node.id}")
        if isinstance(node, ast.Attribute) and node.attr == "open":
            errors.append(f"{name}:{node.lineno}: logic references file open")
        if isinstance(node, ast.Attribute) and node.attr == "dump":
            errors.append(f"{name}:{node.lineno}: logic references stream output")
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            errors.append(f"{name}:{node.lineno}: logic writes shared scope")
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in memory_modules and node.attr not in {"StringIO", "BytesIO"}:
            errors.append(f"{name}:{node.lineno}: logic references external io operation")
    return errors


def main(argv):
    root = Path(argv[0])
    roles = json.loads((root / "architecture.json").read_text())
    errors = []
    for name, role in roles.items():
        if role == "logic" and name.endswith(".py"):
            errors.extend(check_module(name, (root / name).read_text(), roles))
    print(json.dumps(errors))


if __name__ == "__main__":
    main(sys.argv[1:])
