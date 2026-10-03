import re
import sys


values = {
    "app_id": "{{ cookiecutter.app_id }}",
    "package_name": "{{ cookiecutter.package_name }}",
}

for field, value in values.items():
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
        print(f"{field} must contain lowercase words separated by single dashes.", file=sys.stderr)
        sys.exit(1)

port = "{{ cookiecutter.port }}"
if not port.isdigit() or not 1 <= int(port) <= 65535:
    print("port must be an integer from 1 through 65535.", file=sys.stderr)
    sys.exit(1)
