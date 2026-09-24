import json
import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from privacy_engine import detector, mark_value, prepare, restore, Blocked, wire_ref
import server


def local_model(messages, schema, model=None):
    text = messages[1]['content']
    return {'entities': [{'text': name, 'kind':'PERSON'} for name in ['Alice Morgan', 'Bob Smith'] if name in text]}


class PrivacyTests(unittest.TestCase):
    def test_private_values_only_return_in_local_display(self):
        original='Please email Alice Morgan at alice@example.test. password="four-secret-words"'
        source=detector.Vault()
        vault,history,redacted,outbound=prepare(original,source,[],lambda _:None,local_call=local_model)
        for private in ['Alice Morgan','alice@example.test','four-secret-words']:
            self.assertNotIn(private,outbound)
        self.assertEqual(restore(redacted,vault),original)
        self.assertEqual(source.values,{})
        self.assertEqual(history[-1]['content'],redacted)
        self.assertNotIn(json.dumps(vault.values),outbound)

    def test_followup_reuses_vault_without_sending_restored_reply(self):
        vault,history,redacted,_=prepare('Write to Alice Morgan.',detector.Vault(),[],lambda _:None,local_call=local_model)
        person=next(iter(vault.values))
        history.append({'role':'assistant','content':f'Hello {person}.'})
        vault,history,redacted,outbound=prepare('Alice Morgan prefers email.',vault,history,lambda _:None,local_call=local_model)
        self.assertIn(wire_ref(person),redacted)
        self.assertNotIn('Alice Morgan',outbound)
        self.assertEqual(restore(history[1]['content'],vault),'Hello Alice Morgan.')

    def test_new_findings_remask_previous_history(self):
        history=[{'role':'user','content':'Bob Smith is joining.'}]
        vault,updated,_,outbound=prepare('Write to Bob Smith.',detector.Vault(),history,lambda _:None,local_call=local_model)
        self.assertNotIn('Bob Smith',outbound)
        self.assertEqual(history[0]['content'],'Bob Smith is joining.')

    def test_detection_failure_blocks_output(self):
        def failed(*args,**kwargs): raise Blocked('Local model failed.')
        with self.assertRaises(Blocked): prepare('Contact Alice Morgan.',detector.Vault(),[],lambda _:None,local_call=failed)

    def test_reserved_unknown_and_damaged_references_are_rejected(self):
        vault=detector.Vault()
        for text in ['__PRIVATE_PERSON_bad_0001__','__PRIVATE_PERSON_broken','[[PRIVATE_PERSON_bad_0001]]','[[PRIVATE_PERSON_broken']:
            with self.assertRaises(Blocked): restore(text,vault)
        with self.assertRaises(Blocked): prepare('__PRIVATE_EMAIL_abcdef_0001__',vault,[],lambda _:None,local_call=local_model)

    def test_html_remains_plain_data(self):
        value='<script>alert(1)</script>'
        vault=detector.Vault(); ref=vault.hide(value)
        self.assertEqual(restore(ref,vault),value)

    def test_wire_markers_survive_markdown_as_plain_text(self):
        vault,history,redacted,outbound=prepare('Alice Morgan',detector.Vault(),[],lambda _:None,local_call=local_model)
        self.assertTrue(redacted.startswith('[[PRIVATE_PERSON_'))
        self.assertNotIn('__PRIVATE_',outbound)
        self.assertEqual(restore(redacted,vault),'Alice Morgan')

    def test_marking_hides_more_and_never_reveals(self):
        original='Email Alice Morgan about the Kestrel audit.'
        vault,history,redacted,outbound=prepare(original,detector.Vault(),[],lambda _:None,local_call=local_model)
        self.assertIn('Kestrel',outbound)
        marked_vault,marked_history,marked_redacted,marked_outbound=mark_value(redacted,[],vault,'Kestrel','PROJECT')
        self.assertNotIn('Kestrel',marked_outbound)
        self.assertNotIn('Alice Morgan',marked_outbound)
        self.assertEqual(restore(marked_redacted,marked_vault),original)
        self.assertEqual(len(vault.values),1)

    def test_marking_rejects_absent_text_reference_syntax_and_bad_kind(self):
        vault,_,redacted,_=prepare('Email Alice Morgan.',detector.Vault(),[],lambda _:None,local_call=local_model)
        for text,kind in [('Nowhere','PERSON'),(redacted,'PERSON'),('Email','MADE_UP'),('','PERSON')]:
            with self.assertRaises(Blocked): mark_value(redacted,[],vault,text,kind)

    def test_input_size_limit(self):
        with self.assertRaises(Blocked): prepare('x'*12001,detector.Vault(),[],lambda _:None,local_call=local_model)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        server.app.config['TESTING']=True
        server.chats.clear()
        self.client=server.app.test_client()
        self.origin='http://127.0.0.1:8787'
        self.headers={'Origin':self.origin,'X-Private-Chat':'1'}

    def post(self,path,body=None,client=None):
        return (client or self.client).post(path,base_url=self.origin,headers=self.headers,json=body or {})

    def test_settings_page_can_change_the_model_address(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config=Path(folder)/'config.json'
            with patch.object(server,'CONFIG',config):
                saved=self.post('/api/settings',{'local_ai':'http://10.0.0.4:11434/','local_model':'llama9:latest'}).get_json()
                self.assertEqual(saved['local_ai'],'http://10.0.0.4:11434')
                self.assertEqual(saved['local_model'],'llama9:latest')
                self.assertFalse(saved['remote'])
                self.assertEqual(json.loads(config.read_text(encoding='utf-8'))['local_ai'],'http://10.0.0.4:11434')
                # A public host still needs the explicit opt-in.
                self.assertEqual(self.post('/api/settings',{'local_ai':'https://tunnel.ngrok.app','local_model':'m'}).status_code,422)
                remote=self.post('/api/settings',{'local_ai':'https://tunnel.ngrok.app','local_model':'m','allow_remote_ai':True,'ai_auth_token':'tunnel-token'}).get_json()
                self.assertTrue(remote['remote'] and remote['authenticated'])
                self.assertNotIn('tunnel-token',json.dumps(remote))
                # A blank token keeps the saved one; clearing is explicit.
                kept=self.post('/api/settings',{'local_ai':'https://tunnel.ngrok.app','local_model':'m','allow_remote_ai':True,'ai_auth_token':''}).get_json()
                self.assertTrue(kept['authenticated'])
                cleared=self.post('/api/settings',{'local_ai':'https://tunnel.ngrok.app','local_model':'m','allow_remote_ai':True,'clear_token':True}).get_json()
                self.assertFalse(cleared['authenticated'])
                for bad in [{'local_ai':'','local_model':'m'},{'local_ai':'http://8.8.8.8:11434','local_model':'m'},{'local_ai':'http://10.0.0.4:11434','local_model':''}]:
                    self.assertEqual(self.post('/api/settings',bad).status_code,422)
        for name in ['PI_PRIVACY_ENDPOINT','PI_PRIVACY_MODEL','PI_PRIVACY_ALLOW_REMOTE','PI_PRIVACY_AUTH_TOKEN']:
            os.environ.pop(name,None)

    def test_remote_endpoint_requires_opt_in_and_tls(self):
        tunnel='https://private-chat.ngrok.app'
        with self.assertRaises(Blocked): detector.approved_endpoint(tunnel)
        with patch.dict('os.environ',{'PI_PRIVACY_ALLOW_REMOTE':'1'}):
            self.assertEqual(detector.approved_endpoint(tunnel),tunnel)
            self.assertTrue(detector.is_remote(tunnel))
            for endpoint in ['http://private-chat.ngrok.app','ftp://host','https://']:
                with self.assertRaises(Blocked): detector.approved_endpoint(endpoint)
        with self.assertRaises(Blocked): detector.approved_endpoint(tunnel)

    def test_detector_credentials_are_sent_but_never_published(self):
        self.assertEqual(detector.auth_header(),{})
        with patch.dict('os.environ',{'PI_PRIVACY_AUTH_TOKEN':'s3cret-token'}):
            self.assertEqual(detector.auth_header(),{'Authorization':'Bearer s3cret-token'})
            health=self.client.get('/api/health',base_url=self.origin).get_json()
            self.assertTrue(health['authenticated'])
            self.assertNotIn('s3cret-token',json.dumps(health))
        with patch.dict('os.environ',{'PI_PRIVACY_AUTH_TOKEN':'user:pass'}):
            self.assertEqual(detector.auth_header(),{'Authorization':'Basic dXNlcjpwYXNz'})
        with patch.dict('os.environ',{'PI_PRIVACY_AUTH_TOKEN':'Bearer already-formatted'}):
            self.assertEqual(detector.auth_header(),{'Authorization':'Bearer already-formatted'})

    def test_local_endpoint_is_configurable_but_stays_private(self):
        for endpoint in ['http://192.168.1.212:11434','http://127.0.0.1:11434','http://10.0.0.5:11434','http://localhost:11434/']:
            self.assertTrue(detector.approved_endpoint(endpoint).startswith('http://'))
        for endpoint in ['http://8.8.8.8:11434','https://192.168.1.212:11434','http://ollama.example.com:11434','not-a-url','http://172.32.0.1:11434']:
            with self.assertRaises(Blocked): detector.approved_endpoint(endpoint)
        with patch.dict('os.environ',{'PI_PRIVACY_ENDPOINT':'http://192.168.1.99:11434'}):
            self.assertEqual(detector.configured_local_endpoint(),'http://192.168.1.99:11434')
            self.assertEqual(self.client.get('/api/health',base_url=self.origin).get_json()['local_ai'],'http://192.168.1.99:11434')
        self.assertEqual(detector.configured_local_endpoint(),detector.DEFAULT_ENDPOINT)

    def test_cross_origin_and_host_rejected(self):
        self.assertEqual(self.client.post('/api/chats',base_url=self.origin,json={}).status_code,403)
        self.assertEqual(self.client.get('/',base_url='http://evil.test:8787').status_code,403)
        response=self.client.get('/',base_url=self.origin)
        self.assertIn("default-src 'self'",response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        response.close()

    def test_sessions_isolate_vaults(self):
        chat=self.post('/api/chats').get_json()
        other=server.app.test_client()
        response=other.get('/api/chats/'+chat['id'],base_url=self.origin)
        self.assertEqual(response.status_code,404)
        self.assertNotIn('vault',chat)
        self.assertNotIn('owner',chat)

    def test_prepare_reply_roundtrip_and_duplicate_reply(self):
        chat=self.post('/api/chats').get_json(); cid=chat['id']
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Email Alice Morgan at alice@example.test.',server.chats[cid]['vault'],[])
        data=self.client.get('/api/chats/'+cid,base_url=self.origin).get_json()
        pending=data['pending']
        self.assertNotIn('alice@example.test',pending['outbound'])
        response=self.post('/api/chats/'+cid+'/reply',{'turn':pending['id'],'text':pending['redacted']})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.get_json()['messages'][-1]['text'],pending['original'])
        self.assertEqual(self.post('/api/chats/'+cid+'/reply',{'turn':pending['id'],'text':'duplicate'}).status_code,409)
        self.assertNotIn('alice@example.test',json.dumps(server.chats[cid]['history']))

    def test_review_mode_marks_missed_value_before_sending(self):
        chat=self.post('/api/chats').get_json(); cid=chat['id']
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Email Alice Morgan about the Kestrel audit.',server.chats[cid]['vault'],[],True)
        state=self.client.get('/api/chats/'+cid,base_url=self.origin).get_json()
        self.assertEqual(state['state'],'reviewing')
        turn=state['pending']['id']
        # Nothing may be sent while a message is under review.
        self.assertEqual(self.post('/api/chats/'+cid+'/sending',{'turn':turn}).status_code,409)
        self.assertIn('Kestrel',state['pending']['outbound'])
        marked=self.post('/api/chats/'+cid+'/mark',{'turn':turn,'text':'Kestrel','kind':'PROJECT'})
        self.assertEqual(marked.status_code,200)
        pending=marked.get_json()['pending']
        self.assertNotIn('Kestrel',pending['outbound'])
        self.assertEqual(pending['references'],2)
        self.assertEqual(self.post('/api/chats/'+cid+'/approve',{'turn':turn}).get_json()['state'],'prepared')
        self.assertEqual(self.post('/api/chats/'+cid+'/sending',{'turn':turn}).status_code,200)
        restored=self.post('/api/chats/'+cid+'/reply',{'turn':turn,'text':pending['redacted']}).get_json()
        self.assertEqual(restored['messages'][-1]['text'],'Email Alice Morgan about the Kestrel audit.')

    def test_review_rejects_text_outside_the_message(self):
        cid=self.post('/api/chats').get_json()['id']
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Email Alice Morgan.',server.chats[cid]['vault'],[],True)
        turn=server.chats[cid]['pending']['id']
        self.assertEqual(self.post('/api/chats/'+cid+'/mark',{'turn':turn,'text':'Nowhere','kind':'PERSON'}).status_code,422)
        self.assertEqual(self.post('/api/chats/'+cid+'/mark',{'turn':turn,'text':'Email','kind':'NOPE'}).status_code,422)
        self.assertEqual(server.chats[cid]['state'],'reviewing')

    def test_default_mode_skips_review(self):
        cid=self.post('/api/chats').get_json()['id']
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Email Alice Morgan.',server.chats[cid]['vault'],[])
        self.assertEqual(server.chats[cid]['state'],'prepared')
        turn=server.chats[cid]['pending']['id']
        self.assertEqual(self.post('/api/chats/'+cid+'/mark',{'turn':turn,'text':'Email','kind':'VALUE'}).status_code,409)

    def test_cancel_discards_inflight_redaction(self):
        cid=self.post('/api/chats').get_json()['id']
        self.post('/api/chats/'+cid+'/cancel')
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Alice Morgan',server.chats[cid]['vault'],[])
        self.assertIsNone(server.chats[cid]['pending'])

    def test_rejects_empty_reply_and_bad_input(self):
        cid=self.post('/api/chats').get_json()['id']
        self.assertEqual(self.post('/api/chats/'+cid+'/prepare',{'text':'x'*12001}).status_code,400)
        with patch('server.prepare',side_effect=lambda original,vault,history,progress:prepare(original,vault,history,progress,local_call=local_model)):
            server.redact_job(cid,0,'Alice Morgan',server.chats[cid]['vault'],[])
        turn=server.chats[cid]['pending']['id']
        self.assertEqual(self.post('/api/chats/'+cid+'/reply',{'turn':turn,'text':''}).status_code,422)
        self.assertEqual(self.post('/api/chats/'+cid+'/reply',{'turn':turn,'text':'[[PRIVATE_PERSON_broken]]'}).status_code,422)
        self.assertEqual(server.chats[cid]['messages'],[])

if __name__=='__main__': unittest.main()
