import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('privacy_under_test', ROOT / 'vendor' / 'privacy.py')
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PrivacyDetectorTests(unittest.TestCase):
    def test_generic_roles_are_not_redacted_even_if_model_overclassifies_them(self):
        text = ('Sales, Customer Services and Finance can create a System Administrator. '
                'View Only, Editorial and Data-Dev cannot.')

        def overzealous_model(_messages, _schema, model=None):
            return {'entities': [
                {'text': 'Sales', 'kind': 'CLIENT'},
                {'text': 'Customer Services', 'kind': 'CLIENT'},
                {'text': 'Finance', 'kind': 'CLIENT'},
                {'text': 'System Administrator', 'kind': 'CLIENT'},
                {'text': 'View Only', 'kind': 'PROJECT'},
                {'text': 'Editorial', 'kind': 'SCOPE'},
                {'text': 'Data-Dev', 'kind': 'VALUE'},
            ]}

        vault = privacy.Vault(namespace='test')
        result = privacy.redact_text(text, vault, local_call=overzealous_model)

        self.assertEqual(text, result)
        self.assertEqual({}, vault.values)

    def test_role_backstop_does_not_exempt_an_embedded_client_name(self):
        text = 'Create an Acme Finance Administrator account.'

        def model(_messages, _schema, model=None):
            return {'entities': [{'text': 'Acme Finance', 'kind': 'CLIENT'}]}

        vault = privacy.Vault(namespace='test')
        result = privacy.redact_text(text, vault, local_call=model)

        self.assertEqual('Create an __PRIVATE_CLIENT_test_0001__ Administrator account.', result)
        self.assertEqual(['Acme Finance'], list(vault.values.values()))

    def test_default_prompt_preserves_finding_titles_and_role_names(self):
        prompt = privacy.DETECTOR_PROMPT
        self.assertIn('vulnerability or ticket title', prompt)
        self.assertIn('user role', prompt)
        self.assertIn('extract only that embedded name', prompt)


if __name__ == '__main__':
    unittest.main()
