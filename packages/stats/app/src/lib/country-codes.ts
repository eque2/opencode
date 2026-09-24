import countryCodesSource from "i18n-iso-countries/codes.json?raw"
import { Schema } from "effect"

// Each row is [alpha-2, alpha-3, numeric, ...further codes such as ISO 3166-2].
const IsoCountryCodes = Schema.fromJsonString(
  Schema.Array(Schema.TupleWithRest(Schema.Tuple([Schema.String, Schema.String, Schema.String]), [Schema.String])),
)

export const countryNumericIds = new Map(
  Schema.decodeUnknownSync(IsoCountryCodes)(countryCodesSource).map((country) => [country[0], country[2]] as const),
)
