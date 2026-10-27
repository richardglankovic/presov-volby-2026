"""Publish only through the user-confirmed personal GitHub identity.

Identity settings come from ignored publish.local.json. Missing settings stop
publication before any credential or network access; no global identity is used.
Tokens are retrieved from Git Credential Manager, kept in memory, and never
printed, persisted in this repository, or passed as command-line arguments.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / 'publish.local.json'
CONFIG = json.loads(CONFIG_PATH.read_text(encoding='utf-8')) if CONFIG_PATH.exists() else {}
OWNER = CONFIG.get('owner')
REPOSITORY = CONFIG.get('repository')
AUTHOR_EMAIL = CONFIG.get('authorEmail')
REMOTE = f'https://{OWNER}@github.com/{OWNER}/{REPOSITORY}.git' if OWNER and REPOSITORY else None
API = 'https://api.github.com'

def require_identity():
    if not all(isinstance(value, str) and value.strip() for value in (OWNER, REPOSITORY, AUTHOR_EMAIL, REMOTE)):
        raise RuntimeError('Configure the confirmed publishing identity in ignored publish.local.json before accessing GitHub. No account is inferred from global settings.')

def git(*args, env=None):
    result = subprocess.run(['git', *args], cwd=ROOT, env=env, text=True, capture_output=True, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError(f'Git {args[0]} failed: {result.stderr.strip()}')
    return result.stdout.strip()

def local_identity():
    require_identity()
    checks = {
        'remote': (git('remote', 'get-url', 'origin'), REMOTE),
        'authorName': (git('config', '--local', '--get', 'user.name'), OWNER),
        'authorEmail': (git('config', '--local', '--get', 'user.email'), AUTHOR_EMAIL),
        'credentialUsername': (git('config', '--local', '--get', 'credential.https://github.com.username'), OWNER),
    }
    for name, (actual, expected) in checks.items():
        if actual != expected:
            raise RuntimeError(f'{name} mismatch: expected {expected!r}, got {actual!r}. No GitHub changes made.')
    return {name: actual for name, (actual, _) in checks.items()}

def credential():
    require_identity()
    env = os.environ.copy()
    env.update({'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'Never'})
    for key in list(env):
        if key.startswith(('GIT_TRACE', 'GCM_TRACE')) or key == 'GIT_CURL_VERBOSE':
            env.pop(key)
    proc = subprocess.run(['git', 'credential-manager', 'get'], cwd=ROOT, input=f'protocol=https\nhost=github.com\nusername={OWNER}\n\n', capture_output=True, text=True, env=env)
    values = dict(line.split('=', 1) for line in proc.stdout.splitlines() if '=' in line)
    if proc.returncode or not values.get('password'):
        raise RuntimeError(f'The confirmed GitHub credential is not available. Complete the {OWNER} sign-in first.')
    if values.get('username', '').lower() != OWNER:
        raise RuntimeError('Credential Manager returned another account. Stopped without using it.')
    return values['password']

class GitHub:
    def __init__(self, token):
        require_identity()
        self.token = token
        self.login = self.call('GET', '/user')['login']
        if self.login != OWNER:
            raise RuntimeError(f'Authenticated GitHub login is {self.login!r}, expected {OWNER!r}. No GitHub changes made.')

    def call(self, method, path, body=None, missing_ok=False):
        req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode('utf-8') if body is not None else None, headers={'Authorization': f'Bearer {self.token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PresovElectionMap', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            try:
                detail = json.loads(error.read()).get('message', '')
            except (ValueError, AttributeError):
                detail = ''
            raise RuntimeError(f'GitHub {method} {path}: HTTP {error.code} {detail}') from None

    def verified_repository(self, missing_ok=False):
        require_identity()
        repo = self.call('GET', f'/repos/{OWNER}/{REPOSITORY}', missing_ok=missing_ok)
        if repo and (repo['owner']['login'] != OWNER or repo['name'] != REPOSITORY or repo['private']):
            raise RuntimeError('Repository owner, name, or public visibility does not match the confirmed destination.')
        return repo

    def verified_push(self):
        # Recheck both identity and account immediately before transferring data.
        local_identity()
        if self.call('GET', '/user')['login'] != OWNER:
            raise RuntimeError('Authenticated account changed before push.')
        self.verified_repository()
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(('GIT_TRACE', 'GCM_TRACE', 'GIT_CONFIG_')) or key == 'GIT_CURL_VERBOSE':
                env.pop(key)
        basic = base64.b64encode(f'{OWNER}:{self.token}'.encode()).decode()
        # Clear other helpers/headers and bind this push to the verified token.
        env.update({'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '3', 'GIT_CONFIG_KEY_0': 'credential.helper', 'GIT_CONFIG_VALUE_0': '', 'GIT_CONFIG_KEY_1': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_1': '', 'GIT_CONFIG_KEY_2': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_2': f'AUTHORIZATION: basic {basic}'})
        git('push', '--set-upstream', 'origin', 'main', env=env)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-local', action='store_true')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--rerun-failed', type=int, metavar='RUN_ID')
    args = parser.parse_args()
    identity = local_identity()
    if args.check_local:
        print(json.dumps(identity))
        return
    gh = GitHub(credential())
    print(f'Authenticated personal account: {gh.login}', flush=True)
    path = f'/repos/{OWNER}/{REPOSITORY}'
    if args.publish:
        if git('status', '--porcelain'):
            raise RuntimeError('Commit the reviewed source before publication.')
        if git('log', '-1', '--format=%an') != OWNER or git('log', '-1', '--format=%ae') != AUTHOR_EMAIL:
            raise RuntimeError('The reviewed commit does not use the confirmed personal author identity.')
        repo = gh.verified_repository(missing_ok=True)
        if repo is None:
            repo = gh.call('POST', '/user/repos', {'name': REPOSITORY, 'description': 'Interaktívna mapa výsledkov volieb primátora Prešova 2026.', 'private': False, 'auto_init': False})
            if repo['owner']['login'] != OWNER:
                raise RuntimeError('Unexpected owner returned during repository creation.')
            print(f'Created public repository: {repo["html_url"]}', flush=True)
        gh.verified_push()
        print('Pushed reviewed source with the verified personal credential.', flush=True)
        pages = gh.call('GET', path + '/pages', missing_ok=True)
        if pages is None:
            pages = gh.call('POST', path + '/pages', {'build_type': 'workflow'})
        elif pages.get('build_type') != 'workflow':
            pages = gh.call('PUT', path + '/pages', {'build_type': 'workflow'})
        print(f'Pages configured: {pages.get("html_url", "")}', flush=True)
    if args.rerun_failed:
        runs = gh.call('GET', path + f'/actions/runs/{args.rerun_failed}')
        if runs['repository']['owner']['login'] != OWNER or runs['head_sha'] != git('rev-parse', 'HEAD'):
            raise RuntimeError('Refusing to rerun a workflow for another owner or revision.')
        gh.call('POST', path + f'/actions/runs/{args.rerun_failed}/rerun-failed-jobs', {})
        print(f'Requested retry of failed jobs for run {args.rerun_failed}.', flush=True)
    if args.status or args.publish:
        repo = gh.verified_repository(missing_ok=True)
        if repo is None:
            print('Destination repository does not exist yet.')
            return
        pages = gh.call('GET', path + '/pages', missing_ok=True)
        runs = gh.call('GET', path + '/actions/runs?branch=main&per_page=3')
        print(json.dumps({'repository': repo['html_url'], 'owner': repo['owner']['login'], 'public': not repo['private'], 'pages': {k: pages.get(k) for k in ['html_url', 'status', 'build_type']} if pages else None, 'runs': [{k: r[k] for k in ['id', 'head_sha', 'status', 'conclusion', 'html_url']} for r in runs['workflow_runs']]}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except (RuntimeError, urllib.error.URLError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
