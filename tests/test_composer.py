from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ComposerLimitTests(unittest.TestCase):
    def test_textarea_does_not_silently_truncate_oversized_pastes(self):
        html = (ROOT / 'static' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('maxlength="12000"', html)
        self.assertIn('full text kept; split before sending', html)

    def test_client_enforces_limit_without_slicing_input(self):
        javascript = (ROOT / 'static' / 'app.js').read_text(encoding='utf-8')
        self.assertIn('const MAX_MESSAGE_LENGTH = 12000;', javascript)
        self.assertIn('The full text is still here', javascript)


if __name__ == '__main__':
    unittest.main()
