export type ShippingSpeed = 'standard' | 'express' | 'overnight';

export interface Address {
    line1: string;
    line2?: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
}

export interface Parcel {
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
}

export interface ShippingQuote {
    speed: ShippingSpeed;
    amountCents: number;
    estimatedDays: number;
}

export function normalizeAddress(address: Address): Address {
    return {
        ...address,
        line1: address.line1.trim(),
        line2: address.line2?.trim() || undefined,
        city: address.city.trim(),
        region: address.region.trim().toUpperCase(),
        postalCode: address.postalCode.trim().toUpperCase(),
        country: address.country.trim().toUpperCase(),
    };
}

export function parcelVolume(parcel: Parcel): number {
    return parcel.lengthCm * parcel.widthCm * parcel.heightCm;
}

export function billableWeight(parcel: Parcel): number {
    const dimensionalGrams = Math.ceil(parcelVolume(parcel) / 5);
    return Math.max(parcel.weightGrams, dimensionalGrams);
}

export function quoteShipping(
    parcel: Parcel,
    speed: ShippingSpeed,
): ShippingQuote {
    const weight = billableWeight(parcel);
    const base = 500 + Math.ceil(weight / 500) * 125;
    if (speed === 'overnight') {
        return {
            speed,
            amountCents: base * 3,
            estimatedDays: 1,
        };
    }
    if (speed === 'express') {
        return {
            speed,
            amountCents: base * 2,
            estimatedDays: 2,
        };
    }
    return {
        speed,
        amountCents: base,
        estimatedDays: 5,
    };
}

export function chooseShippingQuote(
    quotes: ShippingQuote[],
    maxAmountCents: number,
    maxDays: number,
): ShippingQuote | undefined {
    return quotes
        .filter(quote =>
            quote.amountCents <= maxAmountCents &&
            quote.estimatedDays <= maxDays)
        .sort((left, right) =>
            left.estimatedDays - right.estimatedDays ||
            left.amountCents - right.amountCents)[0];
}

export function validateParcel(parcel: Parcel): string[] {
    const errors: string[] = [];
    if (parcel.weightGrams <= 0) errors.push('weight must be positive');
    if (parcel.lengthCm <= 0) errors.push('length must be positive');
    if (parcel.widthCm <= 0) errors.push('width must be positive');
    if (parcel.heightCm <= 0) errors.push('height must be positive');
    if (billableWeight(parcel) > 30_000) errors.push('parcel is overweight');
    return errors;
}
