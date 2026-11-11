import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ.get('MUSE_BRIDGE_SOURCE', str(Path(__file__).resolve().parent / 'source/backend/agetor/packages/agent-adapters/muse/muse-desktop-bridge.py')))
spec = importlib.util.spec_from_file_location('muse_bridge', SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class BridgeTests(unittest.TestCase):
    def test_locator_uses_semantics_and_retries_loading(self):
        replies = [SimpleNamespace(returncode=1,stdout='',stderr='MUSE_COMPOSER_NOT_FOUND'),
                   SimpleNamespace(returncode=0,stdout='94,797,430,58|消息 附加文件 发送',stderr='')]
        with patch.object(bridge.subprocess,'run',side_effect=replies) as run, patch.object(bridge.time,'sleep'):
            self.assertEqual(bridge.get_composer_info(), (94,797,430,58,'消息 附加文件 发送'))
            script = run.call_args.args[0][-1]
            self.assertIn('entire contents of w',script)
            self.assertNotIn('group 1 of UI element 1 of scroll area 1',script)
            self.assertEqual(run.call_args.kwargs['timeout'],15)

    def test_accessibility_error_keeps_diagnostics(self):
        with patch.object(bridge.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='Not authorized -1743')) as run:
            with self.assertRaisesRegex(RuntimeError,'Not authorized -1743'):
                bridge.get_composer_info()
            self.assertEqual(run.call_count,1)

    def test_snapshot_preserves_commas_and_multiline_reply(self):
        with patch.object(bridge,'run_ax_script',return_value='消息 附加文件 发送\x1e助手消息：JSON, comma\nsecond line'):
            title,messages=bridge.read_chat_snapshot()
            self.assertEqual(title,'消息 附加文件 发送')
            self.assertEqual(messages,['助手消息：JSON, comma\nsecond line'])

    def test_reply_excludes_old_answers_and_user_prompt(self):
        baseline=['助手消息：very long old answer']
        messages=baseline+['你： test prompt','助手消息：new answer, complete']
        self.assertEqual(bridge.new_reply(messages,baseline,'test prompt'),'new answer, complete')
        self.assertEqual(bridge.new_reply(baseline,baseline,'test prompt'),'')
        self.assertEqual(bridge.new_reply(['unrelated conversation'],baseline,'test prompt'),'')
        # Test displaced baseline when prompt is in visible window
        displaced_window=['你： test prompt (long prompt text)','助手消息：fresh answer']
        self.assertEqual(bridge.new_reply(displaced_window,['displaced historical message'],'test prompt (long prompt text)'),'fresh answer')

    def test_fast_reply_finishes_without_observing_stop_button(self):
        clock=[0.0]
        def sleep(seconds): clock[0]+=seconds
        with patch.object(bridge.time,'monotonic',side_effect=lambda:clock[0]), patch.object(bridge.time,'sleep',side_effect=sleep), patch.object(bridge,'read_chat_snapshot',return_value=('发送',['old','助手消息：new answer'])):
            self.assertEqual(bridge.wait_for_muse_reply(5,['old'],'prompt'),'new answer')

    def test_timeout_cannot_reuse_historical_answer(self):
        clock=[0.0]
        def sleep(seconds): clock[0]+=seconds
        with patch.object(bridge.time,'monotonic',side_effect=lambda:clock[0]), patch.object(bridge.time,'sleep',side_effect=sleep), patch.object(bridge,'read_chat_snapshot',return_value=('发送',['old'])):
            with self.assertRaisesRegex(RuntimeError,'TIMEOUT'):
                bridge.wait_for_muse_reply(2,['old'],'prompt')

if __name__ == '__main__':
    unittest.main()
