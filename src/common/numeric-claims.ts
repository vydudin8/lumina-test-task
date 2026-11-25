// Shared by the LLM guard and the screen that marks what it rejected, so both read a number the same way.

// A number with its currency or percent sign: "$44,945,000" must not pass for "£44,945,000".
export const NUMBER = /[£$€]?\d[\d,]*(?:\.\d+)?%?/g
// Numbers in words are claims too. "one" is left out: it is mostly not a quantity ("one of the largest").
export const NUMBER_WORDS =
	/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?)\b/gi

// One spelling per claim: "£44,945,000" is "£44945000", "Hundreds" is "hundreds".
export const numberKey = (token: string) => token.replace(/,/g, '').replace(/\.$/, '').toLowerCase()
