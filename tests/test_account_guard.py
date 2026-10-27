from pathlib import Path
import base64
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import publish

class AccountGuardTests(unittest.TestCase):
    def setUp(self):
        identity = patch.multiple(publish, OWNER='expected-user', REPOSITORY='example-project', AUTHOR_EMAIL='expected-user@example.invalid', REMOTE='https://expected-user@github.com/expected-user/example-project.git')
        identity.start()
        self.addCleanup(identity.stop)

    def test_missing_private_configuration_stops_before_git_or_network_access(self):
        with patch.multiple(publish, OWNER=None, REPOSITORY=None, AUTHOR_EMAIL=None, REMOTE=None), patch.object(publish, 'git') as git, patch.object(publish.subprocess, 'run') as process, patch.object(publish.GitHub, 'call') as request:
            for action in [publish.local_identity, publish.credential, lambda: publish.GitHub('dummy-test-credential')]:
                with self.assertRaisesRegex(RuntimeError, 'publish.local.json'):
                    action()
            git.assert_not_called()
            process.assert_not_called()
            request.assert_not_called()

    def test_company_author_is_rejected_before_authentication(self):
        values = iter([publish.REMOTE, publish.OWNER, 'other-author@example.invalid', publish.OWNER])
        with patch.object(publish, 'git', side_effect=lambda *args, **kwargs: next(values)):
            with self.assertRaisesRegex(RuntimeError, 'authorEmail mismatch'):
                publish.local_identity()

    def test_other_authenticated_accounts_are_rejected(self):
        for login in ['other-work-account', 'other-alias-account']:
            with patch.object(publish.GitHub, 'call', return_value={'login': login}) as request:
                with self.assertRaisesRegex(RuntimeError, 'Authenticated GitHub login'):
                    publish.GitHub('dummy-test-credential')
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.args, ('GET', '/user'))

    def test_repository_owner_and_visibility_are_checked(self):
        gh = object.__new__(publish.GitHub)
        for repo in [{'owner': {'login': 'other-owner'}, 'name': publish.REPOSITORY, 'private': False}, {'owner': {'login': publish.OWNER}, 'name': publish.REPOSITORY, 'private': True}]:
            with patch.object(gh, 'call', return_value=repo):
                with self.assertRaisesRegex(RuntimeError, 'Repository owner'):
                    gh.verified_repository()

    def test_push_uses_only_the_just_verified_personal_credential(self):
        gh = object.__new__(publish.GitHub)
        gh.token = 'dummy-test-credential'
        with patch.object(publish, 'local_identity') as identity, patch.object(gh, 'call', return_value={'login': publish.OWNER}), patch.object(gh, 'verified_repository') as repository, patch.object(publish, 'git') as git:
            gh.verified_push()
            identity.assert_called_once()
            repository.assert_called_once()
            self.assertEqual(git.call_args.args, ('push', '--set-upstream', 'origin', 'main'))
            env = git.call_args.kwargs['env']
            self.assertEqual(env['GIT_CONFIG_VALUE_0'], '')
            self.assertEqual(env['GIT_CONFIG_VALUE_1'], '')
            header = env['GIT_CONFIG_VALUE_2'].split('basic ', 1)[1]
            self.assertEqual(base64.b64decode(header).decode(), publish.OWNER + ':dummy-test-credential')

if __name__ == '__main__':
    unittest.main()
