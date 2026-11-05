#!/usr/bin/env python3
"""Check the actual SSH action command byte budget without printing any value."""
import json
import os
from pathlib import Path
import re
import sys


def wrapper(text):
    start=text.index('          script: |\n')+len('          script: |\n')
    lines=[]
    for line in text[start:].splitlines():
        if line.strip() and not line.startswith('            '):break
        lines.append(line[12:] if line.startswith('            ') else '')
    return '\n'.join(lines)+'\n'


def command(text,environment):
    names=re.findall(r'^          envs: (.+)$',text,re.MULTILINE)
    if len(names)!=1:raise ValueError('Ambiguous SSH environment')
    names=names[0].split(',')
    if len(set(names))!=len(names) or not all(re.fullmatch(r'[A-Z][A-Z0-9_]*',name) for name in names):raise ValueError('Invalid environment names')
    # Exact drone-ssh1.6.13 escaping: single-quote the value and replace every
    # apostrophe with the shell's close/escaped-quote/reopen sequence.
    exports=["export "+name+"='"+environment[name].replace("'","'\\''")+"'" for name in names if name in environment]
    return '\n'.join(exports+[wrapper(text)])


def main():
    text=(Path(__file__).resolve().parents[2]/'.github/workflows/build-deploy.yml').read_text()
    size=len(command(text,os.environ).encode())+1
    maximum=os.sysconf('SC_PAGESIZE')*32
    if size>=maximum:raise ValueError('SSH command exceeds safe exec argument budget')
    print(json.dumps({'sshPayloadFits':True,'commandBytes':size,'budgetBytes':maximum}))


if __name__=='__main__':
    try:main()
    except Exception:
        print('SSH payload refused before connection; environment values suppressed.',file=sys.stderr);sys.exit(1)
