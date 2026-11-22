export const MAX_BOOKING_ATTENDEES = 50;
export const MAX_GUEST_EMAIL_INPUT = MAX_BOOKING_ATTENDEES * 256;

function isEmailAddress(email: string): boolean {
  return email.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>.]+(?:\.[^\s@,;<>.]+)+$/.test(email);
}

/** Returns each address once, with the booker's address first. */
export function bookingAttendeeEmails(
  bookerEmail: string,
  additionalEmails: readonly string[],
): string[] | null {
  const addresses = [bookerEmail, ...additionalEmails].map((address) => address.trim());
  if (!addresses.every(isEmailAddress)) return null;
  const unique = new Map<string, string>();
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (!unique.has(key)) unique.set(key, address);
  }
  return unique.size <= MAX_BOOKING_ATTENDEES ? [...unique.values()] : null;
}

export function parseBookingAttendees(bookerEmail: string, guestInput: string): string[] | null {
  if (guestInput.length > MAX_GUEST_EMAIL_INPUT) return null;
  const guests = guestInput.split(/[,;\n]/).map((address) => address.trim()).filter(Boolean);
  return bookingAttendeeEmails(bookerEmail, guests);
}
