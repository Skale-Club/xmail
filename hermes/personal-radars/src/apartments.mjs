import { createHash } from 'node:crypto'

const additionalRecurringCostFields = [
  'mandatoryMonthlyFees',
  'parkingMonthly',
  'petMonthly',
]

export function assertApartmentMatchesFilters(input, filters) {
  if (filters.minimumBedrooms != null && (
    input.bedrooms == null
    || input.bedrooms < filters.minimumBedrooms
  )) {
    throw new Error(`at least ${filters.minimumBedrooms} bedroom is required`)
  }
  if (filters.maximumBedrooms != null && (
    input.bedrooms == null
    || input.bedrooms > filters.maximumBedrooms
  )) {
    throw new Error(`at most ${filters.maximumBedrooms} bedrooms are eligible`)
  }
  if (filters.laundryInUnitRequired && input.laundryInUnit !== true) {
    throw new Error('laundryInUnit must be confirmed')
  }
  if (filters.dishwasherRequired && input.dishwasher !== true) {
    throw new Error('dishwasher must be confirmed')
  }
  const parkingFilters = filters.parking
  if (parkingFilters) {
    if (parkingFilters.availabilityMustBeConfirmed && input.parkingAvailabilityConfirmed !== true) {
      throw new Error('parking availability must be confirmed')
    }
    if (!parkingFilters.streetParkingAccepted && input.parkingArrangement === 'street') {
      throw new Error('street parking is not accepted')
    }
    if (!parkingFilters.offSiteParkingAccepted && input.parkingArrangement === 'off_site') {
      throw new Error('off-site parking is not accepted')
    }
    if (input.parkingArrangement === 'overflow') {
      throw new Error('unassigned overflow parking is not accepted')
    }
    if (parkingFilters.maximumWalkDistanceMeters != null && (
      input.parkingWalkMeters == null
      || input.parkingWalkMeters > parkingFilters.maximumWalkDistanceMeters
    )) {
      throw new Error('parking is too far from the residence')
    }
    const includedSpaces = input.parkingSpacesIncluded ?? 0
    const paidSpaces = parkingFilters.secondSpaceMayBePaid
      ? input.additionalPaidParkingSpaces ?? 0
      : 0
    if (includedSpaces + paidSpaces < parkingFilters.minimumVehicleSpaces) {
      throw new Error('two usable parking spaces must be confirmed')
    }
  }
  return true
}

export function normalizeApartment(input) {
  if (typeof input.address !== 'string' || input.address.trim() === '') {
    throw new Error('address is required')
  }
  for (const field of ['baseRent', ...additionalRecurringCostFields, 'estimatedUtilities']) {
    const value = input[field]
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${field} must be a non-negative number`)
    }
  }
  if (input.baseRent == null) throw new Error('baseRent is required')
  if (input.promotion?.freeMonths != null) {
    if (!input.leaseMonths || input.promotion.freeMonths > input.leaseMonths) {
      throw new Error('promotion.freeMonths requires a lease term at least as long as the promotion')
    }
  }
  const normalized = { ...input }
  const freeMonths = normalized.promotion?.freeMonths ?? 0
  normalized.effectiveBaseRent = freeMonths > 0 && normalized.leaseMonths > 0
    ? normalized.baseRent * (normalized.leaseMonths - freeMonths) / normalized.leaseMonths
    : normalized.baseRent
  const additionalRecurringCost = additionalRecurringCostFields.reduce(
    (total, field) => total + (normalized[field] ?? 0), 0)
  normalized.totalMonthlyKnown = normalized.effectiveBaseRent + additionalRecurringCost
  normalized.estimatedMonthlyWithUtilities = normalized.estimatedUtilities == null
    ? null
    : normalized.totalMonthlyKnown + normalized.estimatedUtilities
  const mandatoryFeesUnknown = normalized.mandatoryMonthlyFees == null
  const utilitiesUnknown = normalized.estimatedUtilities == null
  normalized.monthlyTotalCompleteness = mandatoryFeesUnknown && utilitiesUnknown
    ? 'mandatory_fees_and_utilities_unknown'
    : mandatoryFeesUnknown
      ? 'mandatory_fees_unknown'
      : utilitiesUnknown
        ? 'utilities_unknown'
        : 'complete'
  return normalized
}

function normalizeIdentityText(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function apartmentIdentityKey({ address, unit, floorPlan, bedrooms, bathrooms, squareFeet }) {
  const normalizedAddress = normalizeIdentityText(address)
  const normalizedUnit = normalizeIdentityText(unit ?? '')
    .replace(/^(apartment|apt|unit)\s+/, '')
    .replace(/\s+/g, '')
  const unitOrFloorPlan = normalizedUnit || [
    normalizeIdentityText(floorPlan ?? ''),
    bedrooms ?? 'unknown-bedrooms',
    bathrooms ?? 'unknown-bathrooms',
    squareFeet ?? 'unknown-square-feet',
  ].join('|')
  return createHash('sha256')
    .update(`${normalizedAddress}|${unitOrFloorPlan}`)
    .digest('hex')
}
