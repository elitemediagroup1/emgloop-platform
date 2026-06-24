// Demo provider abstractions — Sprint 3 (First Customer Loop).
//
// Self-contained copies of the provider contracts + in-memory MOCK adapters,
// living inside the web app so the Next.js production build needs no
// cross-package transpilation. They mirror @emgloop/providers exactly; the
// canonical versions live in packages/providers/src/{interfaces,mocks}.
//
// IMPORTANT: nothing here calls an external API. Every "send" is recorded in
// memory. Real adapters (Anthropic, Twilio, ElevenLabs, SendGrid, Google) drop
// in later behind these SAME interfaces with zero changes to the loop engine.

export type ProviderCategory =
  | 'ai'
  | 'voice'
  | 'sms'
  | 'email'
  | 'payment'
  | 'calendar';

export interface ProviderContext {
  organizationId: string;
  credentials: Record<string, string>;
  config?: Record<string, unknown>;
}

// --- AI ---------------------------------------------------------------------
export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export type NextAction = 'send_followup_sms' | 'book_appointment' | 'noop';

export interface AIDecision {
  action: NextAction;
  reason: string;
  message: string;
}

export interface AIProvider {
  readonly id: string;
  decide(ctx: ProviderContext, conversation: AIMessage[]): Promise<AIDecision>;
}

// --- SMS --------------------------------------------------------------------
export interface SendSmsRequest {
  to: string;
  from: string;
  body: string;
}

export interface SendSmsResult {
  externalId: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
}

export interface SmsProvider {
  readonly id: string;
  sendSms(ctx: ProviderContext, req: SendSmsRequest): Promise<SendSmsResult>;
}

// --- Calendar ---------------------------------------------------------------
export interface CalendarEventInput {
  title: string;
  start: string;
  end: string;
  attendeeName?: string;
}

export interface CalendarEvent extends CalendarEventInput {
  externalId: string;
  status: 'confirmed' | 'tentative' | 'canceled';
}

export interface CalendarProvider {
  readonly id: string;
  createEvent(
    ctx: ProviderContext,
    input: CalendarEventInput,
  ): Promise<CalendarEvent>;
}

// --- Email / Voice placeholders --------------------------------------------
export interface EmailProvider {
  readonly id: string;
  sendEmail(
    ctx: ProviderContext,
    to: string,
    subject: string,
    body: string,
  ): Promise<{ externalId: string }>;
}

export interface VoiceProvider {
  readonly id: string;
  // Placeholder only; no synthesis in the demo.
  synthesize(ctx: ProviderContext, text: string): Promise<{ durationMs: number }>;
}

const ISO = () => new Date().toISOString();
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

// --- Mock implementations ---------------------------------------------------
export const mockAI: AIProvider = {
  id: 'mock',
  async decide(_ctx, conversation) {
    const lastUser = [...conversation]
      .reverse()
      .find((m) => m.role === 'user');
    const t = (lastUser?.content ?? '').toLowerCase();

    if (/yes|sounds good|book|tomorrow|works|confirm/.test(t)) {
      return {
        action: 'book_appointment',
        reason: 'Customer confirmed; proceed to booking.',
        message: 'Great — you are booked. A confirmation is on its way.',
      };
    }
    if (/quote|hvac|estimate|service/.test(t)) {
      return {
        action: 'send_followup_sms',
        reason: 'New service request; qualify and propose scheduling.',
        message:
          'Hi! Thanks for your HVAC quote request. ' +
          'What day works best this week for a technician visit?',
      };
    }
    return {
      action: 'noop',
      reason: 'No actionable intent detected.',
      message: 'Acknowledged.',
    };
  },
};

export const mockSms: SmsProvider = {
  id: 'mock',
  async sendSms(_ctx, _req) {
    return { externalId: nextId('mock-sms'), status: 'delivered' };
  },
};

export const mockCalendar: CalendarProvider = {
  id: 'mock',
  async createEvent(_ctx, input) {
    return { ...input, externalId: nextId('mock-cal'), status: 'confirmed' };
  },
};

export const mockEmail: EmailProvider = {
  id: 'mock',
  async sendEmail(_ctx, _to, _subject, _body) {
    return { externalId: nextId('mock-email') };
  },
};

export const mockVoice: VoiceProvider = {
  id: 'mock',
  async synthesize(_ctx, _text) {
    return { durationMs: 0 };
  },
};

export const demoProviders = {
  ai: mockAI,
  sms: mockSms,
  calendar: mockCalendar,
  email: mockEmail,
  voice: mockVoice,
};

export const demoContext: ProviderContext = {
  organizationId: 'org-demo-servicesinmycity',
  credentials: {},
};

export { ISO };
