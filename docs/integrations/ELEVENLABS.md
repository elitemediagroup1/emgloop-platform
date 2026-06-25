# ElevenLabs — Integration Planning

Sprint 10. Planning only. No implementation.

ElevenLabs provides AI voice synthesis. In Loop, ElevenLabs powers the voice
layer for AI Employees — giving them a configurable voice identity.
ElevenLabs is a VoiceProvider, not an IngestionProvider. It does not produce
inbound events or signals. It is a capability provider only.

---

## Authentication Model

- Type: API Key in xi-api-key header
- Per-AI-Employee: each AI Employee can have a preferred voice (voiceId)
- Storage: credentialsRef on ProviderConnection (org-level API key)
- Voice ID: stored in AIEmployee.providerPrefs.voiceProvider config

---

## Webhook Model

ElevenLabs does not deliver inbound webhooks for TTS synthesis.
All requests are outbound (Loop -> ElevenLabs) for voice generation.

ElevenLabs Conversational AI (if used): may support turn-based callbacks
for real-time conversation, but this is out of scope for Sprint 10.

---

## Polling Model

Not applicable. ElevenLabs is synchronous request/response for TTS.

---

## Rate Limits

- Creator plan: 100K characters/month
- Starter plan: 30K characters/month
- Concurrent requests: limited by plan
- Latency: ~200ms for short utterances on standard voices

---

## Loop Integration Pattern

ElevenLabs operates as a VoiceProvider. It does NOT produce signals or interactions.
It is invoked by the AI Employee engine when voice output is needed:

1. AI Employee receives a message/task
2. AI reasoning layer generates text response
3. VoiceProvider.synthesize(text, voiceId) -> audio stream
4. Audio delivered to caller (via Twilio/Telnyx)

No Loop entities are created by ElevenLabs itself.
The Interaction row is created by the voice provider (Twilio/Telnyx) that delivers the call.

---

## AI Employee Voice Configuration

Stored in AIEmployee.providerPrefs:
{
  "voiceProvider": "elevenlabs",
  "voiceId": "21m00Tcm4TlvDq8ikWAM",
  "stability": 0.5,
  "similarityBoost": 0.75,
  "modelId": "eleven_multilingual_v2"
}

This is configuration only in Sprint 10. No API calls until the voice engine is built.

---

## Notes

- ElevenLabs is provider-agnostic: swap with PlayHT, Deepgram TTS, or Google TTS
  without changing AI Employee business logic
- Voice cloning: not planned; use off-the-shelf voices only
- Not in scope Sprint 10: API client, audio streaming pipeline, real-time TTS
