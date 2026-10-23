// Smoke test for the enterprise signup credential policy. Run:
//   npx tsx scripts/test-credential-policy.ts
import { validateEmail, validatePassword } from "../backend/app/src/services/credentialPolicy";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("Email validation:");
check("rejects malformed (no @)", !!validateEmail("not-an-email"));
check("rejects malformed (no TLD)", !!validateEmail("user@localhost"));
check("rejects empty", !!validateEmail(""));
check("rejects disposable: mailinator", !!validateEmail("a@mailinator.com"));
check("rejects disposable: 10minutemail", !!validateEmail("a@10minutemail.com"));
check("rejects disposable: guerrillamail", !!validateEmail("a@guerrillamail.com"));
check("rejects disposable: tempmail", !!validateEmail("a@tempmail.com"));
check("rejects double-dot domain", !!validateEmail("a@bad..com"));
check("accepts normal work email", !validateEmail("jane.doe@company.com"));
check("accepts gmail", !validateEmail("someone@gmail.com"));
check("normalizes case (accepts upper)", !validateEmail("Jane@Company.COM"));

console.log("\nPassword validation:");
check("rejects < 12 chars", !!validatePassword("Ab1!xyz"));
check("rejects no uppercase", !!validatePassword("abcdef123!@#"));
check("rejects no lowercase", !!validatePassword("ABCDEF123!@#"));
check("rejects no number", !!validatePassword("Abcdefghij!@"));
check("rejects no special char", !!validatePassword("Abcdefghij12"));
check("rejects common password", !!validatePassword("Password1234!"));
check("rejects email-based password", !!validatePassword("Janedoe123!@#", { email: "janedoe@company.com" }));
check("rejects name-based password", !!validatePassword("Jennifer123!@", { name: "Jennifer Smith" }));
check("accepts strong unique password", !validatePassword("Tr0ub4dour&3x!", { email: "x@y.com", name: "Sam Lee" }));
check("accepts long passphrase", !validatePassword("Correct-Horse-Battery-9!", { email: "x@y.com" }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
