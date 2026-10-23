// Curated, categorized emoji dataset for the reaction + composer pickers.
// Static data — NO runtime dependency (tree-shaken into the chat chunk). Each
// entry is [char, keywords]. Kept to a sensible everyday set (~250) to bound the
// bundle while covering far more than the old 32-emoji list, with search.

export interface EmojiEntry { char: string; keywords: string; }
export interface EmojiCategory { id: string; label: string; emojis: EmojiEntry[]; }

const C = (char: string, keywords: string): EmojiEntry => ({ char, keywords });

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { id: "smileys", label: "Smileys & People", emojis: [
    C("😀", "grin smile happy"), C("😁", "grin beam happy"), C("😂", "joy laugh cry lol funny"),
    C("🤣", "rofl rolling laugh"), C("😃", "smile happy"), C("😄", "smile happy laugh"),
    C("😅", "sweat smile nervous phew"), C("😆", "laugh haha"), C("😉", "wink"),
    C("😊", "blush smile happy"), C("🙂", "slight smile"), C("🙃", "upside down silly"),
    C("😋", "yum tasty tongue"), C("😌", "relieved calm"), C("😍", "heart eyes love crush"),
    C("🥰", "love hearts adore"), C("😘", "kiss blow"), C("😗", "kiss"), C("😙", "kiss smile"),
    C("🤗", "hug"), C("🤔", "thinking hmm"), C("🤨", "raised eyebrow skeptic"),
    C("😐", "neutral meh"), C("😑", "expressionless"), C("😶", "no mouth silent"),
    C("🙄", "eye roll"), C("😏", "smirk"), C("😣", "persevere"), C("😥", "sad relieved"),
    C("😮", "open mouth wow surprised"), C("🤐", "zipper mouth quiet"), C("😯", "hushed"),
    C("😴", "sleeping tired zzz"), C("😪", "sleepy"), C("😜", "wink tongue silly"),
    C("😝", "tongue playful"), C("🤤", "drool"), C("😒", "unamused"), C("😓", "downcast sweat"),
    C("😔", "pensive sad"), C("🙁", "frown sad"), C("😕", "confused"), C("😟", "worried"),
    C("😦", "anguished"), C("😧", "anguished"), C("😢", "cry sad tear"), C("😭", "sob cry bawl"),
    C("😤", "triumph huff"), C("😠", "angry mad"), C("😡", "rage furious mad"),
    C("🤯", "mind blown shocked exploding"), C("😳", "flushed embarrassed"),
    C("🥵", "hot heat"), C("🥶", "cold freezing"), C("😱", "scream shock fear"),
    C("😨", "fearful scared"), C("😰", "anxious sweat"), C("😥", "sad"), C("🤪", "zany goofy crazy"),
    C("😎", "cool sunglasses chill"), C("🤓", "nerd geek"), C("🧐", "monocle inspect"),
    C("😇", "innocent angel halo"), C("🤩", "star struck wow excited"), C("🥳", "party celebrate hooray"),
    C("😏", "smirk"), C("🤥", "lying liar"), C("🤫", "shush quiet secret"), C("🤭", "giggle oops"),
    C("🤢", "nauseated sick"), C("🤮", "vomit sick"), C("🤧", "sneeze sick"), C("😷", "mask sick"),
    C("🤒", "sick thermometer"), C("🤕", "hurt bandage injured"), C("🥴", "woozy dizzy drunk"),
    C("😈", "devil smiling imp"), C("👿", "devil angry imp"), C("💀", "skull dead"),
    C("👻", "ghost boo"), C("👽", "alien"), C("🤖", "robot bot"), C("🎃", "pumpkin halloween"),
    C("😺", "cat smile"), C("😹", "cat joy"), C("😻", "cat heart eyes love"),
  ]},
  { id: "gestures", label: "Gestures & Body", emojis: [
    C("👍", "thumbs up yes good approve like ok"), C("👎", "thumbs down no bad dislike"),
    C("👌", "ok perfect"), C("🤌", "pinched fingers italian"), C("✌️", "victory peace"),
    C("🤞", "fingers crossed luck hope"), C("🤟", "love you rock"), C("🤘", "rock horns"),
    C("🤙", "call me shaka"), C("👈", "point left"), C("👉", "point right"), C("👆", "point up"),
    C("👇", "point down"), C("☝️", "point up index"), C("✋", "raised hand stop high five"),
    C("🤚", "raised back hand"), C("🖐️", "hand splayed"), C("🖖", "vulcan spock"),
    C("👋", "wave hi bye hello"), C("🤝", "handshake deal agree"), C("👏", "clap applause bravo"),
    C("🙌", "raise hands celebrate yay praise"), C("👐", "open hands"), C("🤲", "palms up pray"),
    C("🙏", "pray thanks please hope namaste"), C("✊", "fist power"), C("👊", "fist bump punch"),
    C("🤛", "fist left"), C("🤜", "fist right"), C("💪", "muscle strong flex"),
    C("✍️", "writing hand"), C("🤳", "selfie"), C("💅", "nails manicure"),
    C("👀", "eyes look watch see"), C("👁️", "eye"), C("👅", "tongue"), C("👄", "lips mouth"),
    C("🧠", "brain smart"), C("🫶", "heart hands love"),
  ]},
  { id: "hearts", label: "Hearts & Emotion", emojis: [
    C("❤️", "red heart love"), C("🧡", "orange heart love"), C("💛", "yellow heart love"),
    C("💚", "green heart love"), C("💙", "blue heart love"), C("💜", "purple heart love"),
    C("🖤", "black heart"), C("🤍", "white heart"), C("🤎", "brown heart"),
    C("💔", "broken heart heartbreak"), C("❣️", "heart exclamation"), C("💕", "two hearts love"),
    C("💞", "revolving hearts"), C("💓", "beating heart"), C("💗", "growing heart"),
    C("💖", "sparkling heart"), C("💘", "heart arrow cupid"), C("💝", "heart gift"),
    C("💟", "heart decoration"), C("💯", "hundred perfect score keep it 100"),
    C("💢", "anger"), C("💥", "boom collision explode"), C("💫", "dizzy stars"),
    C("💦", "sweat droplets water"), C("💨", "dash wind fast"), C("🔥", "fire lit hot flame"),
    C("⭐", "star"), C("🌟", "glowing star"), C("✨", "sparkles shiny"), C("⚡", "lightning bolt"),
    C("🎉", "tada party celebrate congrats"), C("🎊", "confetti celebrate"), C("🎈", "balloon"),
    C("🎁", "gift present"), C("🏆", "trophy win champion"), C("🥇", "first place gold medal"),
    C("👑", "crown king queen"), C("💎", "diamond gem"),
  ]},
  { id: "animals", label: "Animals & Nature", emojis: [
    C("🐶", "dog puppy"), C("🐱", "cat"), C("🐭", "mouse"), C("🐹", "hamster"), C("🐰", "rabbit bunny"),
    C("🦊", "fox"), C("🐻", "bear"), C("🐼", "panda"), C("🐨", "koala"), C("🐯", "tiger"),
    C("🦁", "lion"), C("🐮", "cow"), C("🐷", "pig"), C("🐸", "frog"), C("🐵", "monkey"),
    C("🙈", "see no evil monkey"), C("🐔", "chicken"), C("🐧", "penguin"), C("🐦", "bird"),
    C("🦆", "duck"), C("🦉", "owl"), C("🦄", "unicorn"), C("🐝", "bee"), C("🦋", "butterfly"),
    C("🐢", "turtle"), C("🐙", "octopus"), C("🐠", "fish tropical"), C("🐬", "dolphin"),
    C("🐳", "whale"), C("🦈", "shark"), C("🌵", "cactus"), C("🌲", "tree evergreen"),
    C("🌳", "tree"), C("🌴", "palm tree"), C("🌷", "tulip flower"), C("🌹", "rose flower love"),
    C("🌺", "hibiscus flower"), C("🌸", "blossom flower"), C("🌼", "daisy flower"),
    C("🌻", "sunflower"), C("🍀", "clover luck"), C("🍁", "maple leaf autumn"),
    C("🌍", "earth globe world"), C("🌙", "moon night"), C("☀️", "sun sunny"), C("⛅", "cloud sun"),
    C("☁️", "cloud"), C("🌈", "rainbow"), C("❄️", "snowflake cold winter"), C("🌊", "wave ocean water"),
  ]},
  { id: "food", label: "Food & Drink", emojis: [
    C("🍎", "apple red"), C("🍌", "banana"), C("🍉", "watermelon"), C("🍓", "strawberry"),
    C("🍒", "cherries"), C("🍑", "peach"), C("🥭", "mango"), C("🍍", "pineapple"), C("🥥", "coconut"),
    C("🥝", "kiwi"), C("🍅", "tomato"), C("🥑", "avocado"), C("🌽", "corn"), C("🥕", "carrot"),
    C("🍔", "burger hamburger"), C("🍟", "fries"), C("🍕", "pizza"), C("🌭", "hot dog"),
    C("🌮", "taco"), C("🌯", "burrito"), C("🍝", "pasta spaghetti"), C("🍜", "ramen noodles"),
    C("🍣", "sushi"), C("🍱", "bento"), C("🍦", "ice cream"), C("🍩", "donut"), C("🍪", "cookie"),
    C("🎂", "birthday cake"), C("🍰", "cake slice"), C("🧁", "cupcake"), C("🍫", "chocolate"),
    C("🍬", "candy sweet"), C("🍿", "popcorn"), C("☕", "coffee tea hot"), C("🍵", "tea green"),
    C("🥤", "soda drink cup"), C("🍺", "beer"), C("🍻", "cheers beers"), C("🍷", "wine"),
    C("🥂", "champagne cheers toast"), C("🍸", "cocktail martini"), C("🥃", "whiskey"),
  ]},
  { id: "activity", label: "Activity & Travel", emojis: [
    C("⚽", "soccer football"), C("🏀", "basketball"), C("🏈", "football american"),
    C("⚾", "baseball"), C("🎾", "tennis"), C("🏐", "volleyball"), C("🏉", "rugby"),
    C("🎱", "pool 8 ball"), C("🏓", "ping pong table tennis"), C("🏸", "badminton"),
    C("🥅", "goal net"), C("⛳", "golf"), C("🎯", "dart target bullseye"), C("🎮", "game controller"),
    C("🎲", "dice game"), C("🎸", "guitar"), C("🎹", "piano keyboard music"), C("🎺", "trumpet"),
    C("🎻", "violin"), C("🥁", "drum"), C("🎤", "microphone sing karaoke"), C("🎧", "headphones music"),
    C("🎬", "clapper movie film"), C("🎨", "art palette paint"), C("📷", "camera photo"),
    C("🚗", "car"), C("🚕", "taxi"), C("🚌", "bus"), C("🚲", "bicycle bike"), C("🛴", "scooter"),
    C("✈️", "airplane flight travel"), C("🚀", "rocket launch ship"), C("🚁", "helicopter"),
    C("⛵", "sailboat"), C("🚢", "ship cruise"), C("🏝️", "island beach vacation"),
    C("🗺️", "map travel"), C("🧳", "luggage suitcase travel"), C("⛺", "tent camping"),
    C("🎢", "roller coaster"), C("🎡", "ferris wheel"),
  ]},
  { id: "objects", label: "Objects", emojis: [
    C("💻", "laptop computer"), C("🖥️", "desktop computer"), C("⌨️", "keyboard"),
    C("🖱️", "mouse computer"), C("📱", "phone mobile smartphone"), C("☎️", "telephone call"),
    C("📞", "phone receiver call"), C("📲", "mobile call"), C("🔋", "battery"), C("🔌", "plug power"),
    C("💡", "bulb idea light"), C("🔦", "flashlight"), C("📡", "satellite signal"),
    C("📺", "tv television"), C("📻", "radio"), C("⏰", "alarm clock time"), C("⏱️", "stopwatch timer"),
    C("📅", "calendar date"), C("📆", "calendar"), C("📌", "pin"), C("📎", "paperclip attach"),
    C("✂️", "scissors cut"), C("📁", "folder"), C("📂", "open folder"), C("📄", "page document file"),
    C("📊", "bar chart graph"), C("📈", "chart up growth"), C("📉", "chart down decline"),
    C("📝", "memo note write"), C("✏️", "pencil"), C("🖊️", "pen"), C("📚", "books"),
    C("🔍", "search magnifying glass"), C("🔒", "lock secure"), C("🔑", "key"), C("🔨", "hammer tool"),
    C("🛠️", "tools wrench"), C("⚙️", "gear settings"), C("🧲", "magnet"), C("💰", "money bag cash"),
    C("💵", "dollar money cash"), C("💳", "credit card payment"), C("🛒", "shopping cart"),
    C("🎀", "ribbon bow"), C("📦", "package box delivery"), C("🧨", "firecracker"),
  ]},
  { id: "symbols", label: "Symbols", emojis: [
    C("✅", "check tick done yes correct"), C("❌", "cross no wrong x"), C("❎", "cross mark green"),
    C("➕", "plus add"), C("➖", "minus subtract"), C("➗", "divide"), C("✖️", "multiply"),
    C("❓", "question"), C("❗", "exclamation"), C("‼️", "double exclamation"),
    C("⁉️", "exclamation question"), C("💲", "dollar money"), C("⚠️", "warning caution"),
    C("🚫", "no prohibited forbidden"), C("✔️", "check tick"), C("☑️", "checkbox checked"),
    C("🔴", "red circle"), C("🟠", "orange circle"), C("🟡", "yellow circle"), C("🟢", "green circle"),
    C("🔵", "blue circle"), C("🟣", "purple circle"), C("⚫", "black circle"), C("⚪", "white circle"),
    C("🔺", "red triangle up"), C("🔻", "red triangle down"), C("💠", "diamond"),
    C("🔔", "bell notification"), C("🔕", "bell off mute"), C("📣", "megaphone announce"),
    C("📢", "loudspeaker announce"), C("💬", "speech bubble chat comment"), C("💭", "thought bubble"),
    C("🗯️", "anger bubble"), C("♻️", "recycle"), C("⭕", "circle o"), C("🆗", "ok button"),
    C("🆕", "new button"), C("🔝", "top up"), C("🔙", "back"), C("🎵", "music note"),
    C("🎶", "music notes"), C("➡️", "arrow right"), C("⬅️", "arrow left"), C("⬆️", "arrow up"),
    C("⬇️", "arrow down"), C("🔄", "refresh repeat sync"), C("🔁", "repeat loop"),
    C("♾️", "infinity forever"), C("☮️", "peace"), C("🕐", "clock time"),
  ]},
];

// Flat list (default pool / quick access).
export const ALL_EMOJI_CHARS: string[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));

// Case-insensitive keyword search across all categories.
export function searchEmojis(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: EmojiEntry[] = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const e of cat.emojis) {
      if (e.keywords.includes(q) || e.char === query) out.push(e);
    }
  }
  return out;
}
