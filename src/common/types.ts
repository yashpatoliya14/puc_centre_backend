export function toBool(val: unknown): boolean {
  return val === true || val === 1 || val === '1' || val === 'true';
}

export function normalizeIndianPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+91') && digits.length === 13) return digits;
  const plain = digits.replace(/^\+/, '');
  if (plain.length === 10) return `+91${plain}`;
  if (plain.length === 12 && plain.startsWith('91')) return `+${plain}`;
  return digits.startsWith('+') ? digits : `+91${plain}`;
}

export function normalizeVehicleReg(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]{2})(\d{2})([A-Z]{1,3})(\d{1,4})$/, '$1-$2-$3-$4');
}

export interface TenantRow {
  id: string;
  business_name: string;
  owner_name: string;
  mobile_number: string;
  email: string;
  address: string | null;
  logo_url: string | null;
  timezone: string;
  automation_enabled: number | boolean;
  auto_schedule_on_import: number | boolean;
  default_language: string;
  default_call_time: string;
  calling_window_start: string;
  calling_window_end: string;
  calling_days_json: string;
  max_attempts: number;
  retry_interval_minutes: number;
  max_calls_per_customer: number;
  max_messages_per_customer?: number;
  daily_message_limit?: number;
  delivery_frequency?: string;
  calls_enabled?: number | boolean;
  auto_call_on_registration?: number | boolean;
  messages_enabled?: number | boolean;
  remind_days_before?: string;
  remind_days_after?: string;
  puc_message_template?: string | null;
  insurance_message_template?: string | null;
  voice_script_template?: string | null;
  expiry_warning_days: number;
  is_blocked?: number | boolean;
  blocked_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  mobile_number: string | null;
  password_hash: string;
  role: string;
  email_verified: number | boolean;
  verification_token: string | null;
  reset_token: string | null;
  reset_token_expires_at: string | null;
  theme_preference: string;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuthContext {
  userId: string;
  tenantId: string;
  sessionId: string;
  email: string;
  role: string;
}

export const DEFAULT_GUJARATI_TEMPLATE =
  'નમસ્કાર {customer_name} જી, તમારા વાહન નંબર {vehicle_number} નું PUC સર્ટિફિકેટ {expiry_date} ના રોજ પૂર્ણ થવાનું છે. કૃપા કરીને સમયસર PUC રિન્યુ કરાવી લો. વધુ માહિતી માટે અમારી સાથે સંપર્ક કરો ({contact_number}). આભાર - {centre_name}.';

export const DEFAULT_HINDI_TEMPLATE =
  'नमस्कार {customer_name} जी, आपके वाहन नंबर {vehicle_number} का PUC सर्टिफिकेट {expiry_date} को समाप्त होने वाला है। कृपया समय पर {centre_name} पर PUC रिन्यू करा लें। अधिक जानकारी के लिए {contact_number} पर संपर्क करें। धन्यवाद।';

export const DEFAULT_ENGLISH_TEMPLATE =
  'Hello {customer_name}, this is a reminder from {centre_name}. The PUC certificate for your vehicle {vehicle_number} expires on {expiry_date}. Please visit us for timely renewal or call {contact_number}. Thank you.';

export const DEFAULT_WHATSAPP_PUC_TEMPLATE =
  'PUC Renewal Reminder\nHello {customer_name},\n\nYour vehicle\'s PUC certificate for {vehicle_number} is expiring on {expiry_date}.\n\nPlease renew your PUC certificate before the expiry date to avoid penalties.\n\n🏢 PUC Centre: {centre_name}\n👤 Owner Name: {owner_name}\n📍 Address: {centre_address}\n📞 Contact Number: {contact_number}\n\nThank you for choosing.';

export const DEFAULT_WHATSAPP_INSURANCE_TEMPLATE =
  'Vehicle Insurance Renewal Reminder\nHello {customer_name},\n\nYour vehicle {vehicle_number} insurance policy is expiring on {expiry_date}.\n\n📄 Policy No.: {policy_number}\n🏢 Insurer: {insurance_company}\n\nRenew your policy on time to avoid a lapse in insurance coverage.\n\nFor Renewal Assistance:\n🏢 Centre: {centre_name}\n👤 Owner: {owner_name}\n📞 Contact: {contact_number}\n\nThank you for your trust! 🙏';

export const ALL_CALL_STATUSES = [
  'queued',
  'scheduled',
  'initiated',
  'ringing',
  'answered',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'cancelled',
] as const;

export type CallStatus = (typeof ALL_CALL_STATUSES)[number];
