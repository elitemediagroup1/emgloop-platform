export function bookingBookerName(attributes: unknown): string | undefined {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return;
  const booking = attributes as Record<string, unknown>;
  for (const value of [booking.guestCompany, booking.guestName]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}
