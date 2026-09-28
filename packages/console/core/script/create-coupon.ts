import { Database } from "../src/drizzle/index.js"
import { CouponTable, CouponType } from "../src/schema/billing.sql.js"

const email = process.argv[2]
const typeArg = process.argv[3]

if (!email || !typeArg) {
  console.error(`Usage: bun create-coupon.ts <email> <${CouponType.join("|")}>`)
  process.exit(1)
}

const type = CouponType.find((value) => value === typeArg)
if (!type) {
  console.error(`Error: type must be one of ${CouponType.join(", ")}`)
  process.exit(1)
}

await Database.use((tx) =>
  tx.insert(CouponTable).values({
    email,
    type,
  }),
)

console.log(`Created ${type} coupon for ${email}`)
