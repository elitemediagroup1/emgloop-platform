export interface CreatorContactDetailsInput {
  personalEmail: string;
  phone: string;
  dateOfBirth: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export function validateCreatorContactDetails(
  input: CreatorContactDetailsInput,
  today = new Date().toISOString().slice(0, 10),
): string | null {
  const limits: Record<keyof CreatorContactDetailsInput, number> = {
    personalEmail: 254,
    phone: 40,
    dateOfBirth: 10,
    addressLine1: 200,
    addressLine2: 200,
    city: 100,
    region: 100,
    postalCode: 24,
    country: 80,
  };
  for (const key of Object.keys(limits) as (keyof CreatorContactDetailsInput)[]) {
    if (
      typeof input[key] !== 'string' ||
      input[key].length > limits[key] ||
      /[\u0000-\u001f\u007f]/.test(input[key])
    ) {
      return 'Check the length and formatting of your contact details.';
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.personalEmail))
    return 'Enter a valid personal email address.';
  const digits = input.phone.replace(/\D/g, '');
  if (!/^\+?[\d\s().-]+$/.test(input.phone) || digits.length < 7 || digits.length > 15) {
    return 'Enter a valid phone number, including your country code.';
  }
  const dob = input.dateOfBirth;
  const date = new Date(`${dob}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== dob ||
    dob > today ||
    dob < '0001-01-01'
  ) {
    return 'Enter a valid date of birth.';
  }
  if (
    !input.addressLine1.trim() ||
    !input.city.trim() ||
    !input.postalCode.trim() ||
    !input.country.trim()
  ) {
    return 'Enter your mailing address, city, postal code and country.';
  }
  return null;
}
