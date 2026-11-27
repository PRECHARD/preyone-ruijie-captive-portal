/**
 * Product visuals for the till.
 *
 * Tenants rarely have photographed catalogues, so a bare text tile makes a
 * fast-food counter and an electronics shop look identical. This resolver
 * maps the product's name/category/SKU (then its description) to a recognisable
 * real-world glyph and a colour family. It is deliberately dependency-free so
 * the POS bundle stays small and works offline on a shop till.
 *
 * A tenant can still upload a real photo; `Product.image_url` always wins over
 * the automatic glyph in the UI.
 */

export type ProductTone =
  | 'amber'
  | 'orange'
  | 'rose'
  | 'pink'
  | 'emerald'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'violet'
  | 'slate';

export interface ProductVisual {
  /** Full-colour glyph shown when the product has no uploaded photo. */
  emoji: string;
  /** Colour family used for the tile wash, badge and accent. */
  tone: ProductTone;
  /** Human label for the detected family, e.g. "Chicken" or "Laptop". */
  label: string;
  /** Stable machine key, useful for analytics and tests. */
  kind: string;
}

interface Rule {
  test: RegExp;
  emoji: string;
  tone: ProductTone;
  label: string;
  kind: string;
}

/**
 * Ordered most-specific first. The first match wins, so "chicken burger"
 * resolves to chicken and "laptop bag" resolves to bag only when the name
 * itself says bag.
 */
const RULES: Rule[] = [
  // ── Multi-word phrase priority (checked first) ─────────────────────────
  { test: /\\b(men'?s|women'?s|ladies'?|gents'?|slim fit|skinny fit|regular fit|bootcut)\\s+(jeans|trousers|pants|shirt|jacket|coat|dress)\\b/i, emoji: '👖', tone: 'blue', label: 'Fashion', kind: 'trousers' },
  { test: /\\b(starlink (mini|standard|kit|dish|router|terminal))\\b/i, emoji: '📡', tone: 'cyan', label: 'Starlink', kind: 'router' },
  { test: /\\b(laptop (bag|charger|stand|sleeve|case))\\b/i, emoji: '💼', tone: 'slate', label: 'Laptop accessory', kind: 'bag' },
  { test: /\\b(phone (case|charger|cover|screen protector|holder))\\b/i, emoji: '📱', tone: 'blue', label: 'Phone accessory', kind: 'phone' },
  { test: /\\b(baby (milk|formula|food|wipes|powder|lotion))\\b/i, emoji: '🍼', tone: 'pink', label: 'Baby care', kind: 'feeding' },
  { test: /\\b(fried chicken|grilled chicken|roast chicken|chicken (burger|wrap|salad|pizza))\\b/i, emoji: '🍗', tone: 'amber', label: 'Chicken', kind: 'chicken' },
  { test: /\\b(iced coffee|hot chocolate|energy drink|soft drink)\\b/i, emoji: '🥤', tone: 'rose', label: 'Drink', kind: 'soda' },
  { test: /\\b(solar (panel|inverter|charger|light|garden))\\b/i, emoji: '☀️', tone: 'amber', label: 'Solar', kind: 'generator' },
  { test: /\\b(engine oil|brake (pad|fluid|disc)|spark plug|air filter)\\b/i, emoji: '⚙️', tone: 'slate', label: 'Auto part', kind: 'sparepart' },
  { test: /\\b(hair (dryer|straightener|clipper|trimmer))\\b/i, emoji: '💇', tone: 'pink', label: 'Hair tool', kind: 'salon' },
  { test: /\\b(nail (polish|kit|file|clipper))\\b/i, emoji: '💅', tone: 'pink', label: 'Nails', kind: 'cosmetics' },
  { test: /\\b(water (bottle|filter|pump|tank|heater))\\b/i, emoji: '💧', tone: 'cyan', label: 'Water', kind: 'water' },
  { test: /\\b(office (chair|desk|table|cabinet))\\b/i, emoji: '🪑', tone: 'amber', label: 'Office furniture', kind: 'furniture' },
  { test: /\\b(smart (tv|watch|phone|home|bulb))\\b/i, emoji: '📺', tone: 'violet', label: 'Smart device', kind: 'tv' },
  { test: /\\b(gaming (mouse|keyboard|headset|chair|console))\\b/i, emoji: '🎮', tone: 'violet', label: 'Gaming', kind: 'gaming' },
  { test: /\\b(wireless (mouse|keyboard|charger|earbuds|headphones))\\b/i, emoji: '🎧', tone: 'violet', label: 'Wireless', kind: 'headphones' },
  { test: /\\b(portable (speaker|charger|fan|lamp))\\b/i, emoji: '🔊', tone: 'violet', label: 'Portable', kind: 'speaker' },
  { test: /\\b(indoor (plant|light|fan))\\b/i, emoji: '🪴', tone: 'emerald', label: 'Indoor', kind: 'plant' },
  { test: /\\b(outdoor (light|furniture|tent))\\b/i, emoji: '🏕️', tone: 'emerald', label: 'Outdoor', kind: 'camping' },
  { test: /\\b(fast food (combo|meal|box))\\b/i, emoji: '🍟', tone: 'amber', label: 'Fast food', kind: 'fries' },
  { test: /\\b(ice (cream|tea|coffee))\\b/i, emoji: '🍦', tone: 'pink', label: 'Ice', kind: 'icecream' },
  { test: /\\b(fresh (produce|meat|bread|fruit))\\b/i, emoji: '🥬', tone: 'emerald', label: 'Fresh', kind: 'produce' },
  { test: /\\b(home (theater|theatre|audio|cinema))\\b/i, emoji: '🎬', tone: 'violet', label: 'Home theater', kind: 'tv' },

  // ── Extended vertical coverage (single-keyword fallbacks) ─────────────
  { test: /\\b(tshirt|t-shirt|tee|polo|hoodie|sweater|cardigan|jacket|coat|blazer|suit|tie|scarf)\\b/i, emoji: '🧥', tone: 'blue', label: 'Apparel', kind: 'shirt' },
  { test: /\\b(jeans|denim|chinos|leggings|shorts|skirt|trouser)\\b/i, emoji: '👖', tone: 'blue', label: 'Bottoms', kind: 'trousers' },
  { test: /\\b(dress|gown|romper|jumpsuit|abaya)\\b/i, emoji: '👗', tone: 'pink', label: 'Dress', kind: 'dress' },
  { test: /\\b(sneaker|trainer|heel|sandal|boot|slipper|shoe|footwear)\\b/i, emoji: '👟', tone: 'blue', label: 'Footwear', kind: 'shoes' },
  { test: /\\b(watch|wristwatch|smartwatch|clock)\\b/i, emoji: '⌚', tone: 'blue', label: 'Watch', kind: 'watch' },
  { test: /\\b(ring|necklace|bracelet|earring|pendant|brooch)\\b/i, emoji: '💍', tone: 'amber', label: 'Jewellery', kind: 'jewellery' },
  { test: /\\b(wig|weave|extension|hairpiece)\\b/i, emoji: '👩', tone: 'pink', label: 'Wig', kind: 'wig' },
  { test: /\\b(perfume|fragrance|cologne|deodorant|body spray)\\b/i, emoji: '🧴', tone: 'pink', label: 'Fragrance', kind: 'perfume' },
  { test: /\\b(makeup|lipstick|mascara|foundation|concealer|powder|blush)\\b/i, emoji: '💄', tone: 'pink', label: 'Makeup', kind: 'cosmetics' },
  { test: /\\b(shampoo|conditioner|hair oil|hair cream)\\b/i, emoji: '🧴', tone: 'pink', label: 'Hair care', kind: 'shampoo' },
  { test: /\\b(laptop|notebook|macbook|chromebook)\\b/i, emoji: '💻', tone: 'violet', label: 'Laptop', kind: 'laptop' },
  { test: /\\b(smartphone|iphone|android|galaxy|pixel)\\b/i, emoji: '📱', tone: 'blue', label: 'Phone', kind: 'phone' },
  { test: /\\b(tablet|ipad)\\b/i, emoji: '📲', tone: 'blue', label: 'Tablet', kind: 'tablet' },
  { test: /\\b(monitor|screen|display)\\b/i, emoji: '🖥️', tone: 'violet', label: 'Monitor', kind: 'desktop' },
  { test: /\\b(tv|television)\\b/i, emoji: '📺', tone: 'violet', label: 'TV', kind: 'tv' },
  { test: /\\b(camera|webcam|dslr)\\b/i, emoji: '📷', tone: 'slate', label: 'Camera', kind: 'camera' },
  { test: /\\b(headphone|earbud|airpod|headset)\\b/i, emoji: '🎧', tone: 'violet', label: 'Audio', kind: 'headphones' },
  { test: /\\b(speaker|soundbar|subwoofer)\\b/i, emoji: '🔊', tone: 'violet', label: 'Speaker', kind: 'speaker' },
  { test: /\\b(router|modem|switch|access point|hotspot)\\b/i, emoji: '📡', tone: 'cyan', label: 'Network', kind: 'router' },
  { test: /\\b(charger|adapter|power supply)\\b/i, emoji: '🔌', tone: 'amber', label: 'Charger', kind: 'charger' },
  { test: /\\b(cable|hdmi|usb|ethernet|wire)\\b/i, emoji: '🔗', tone: 'slate', label: 'Cable', kind: 'cable' },
  { test: /\\b(battery|power bank|powerbank)\\b/i, emoji: '🔋', tone: 'emerald', label: 'Power', kind: 'battery' },
  { test: /\\b(ssd|hdd|flash drive|memory card|storage)\\b/i, emoji: '💾', tone: 'slate', label: 'Storage', kind: 'storage' },
  { test: /\\b(console|playstation|xbox|nintendo|controller)\\b/i, emoji: '🎮', tone: 'violet', label: 'Gaming', kind: 'gaming' },
  { test: /\\b(projector)\\b/i, emoji: '📽️', tone: 'violet', label: 'Projector', kind: 'projector' },
  { test: /\\b(tyre|tire|wheel|rim)\\b/i, emoji: '🛞', tone: 'slate', label: 'Tyre', kind: 'tyre' },
  { test: /\\b(battery (car|auto|vehicle))\\b/i, emoji: '🔋', tone: 'emerald', label: 'Auto battery', kind: 'battery' },
  { test: /\\b(brake|clutch|filter|spark plug)\\b/i, emoji: '⚙️', tone: 'slate', label: 'Auto part', kind: 'sparepart' },
  { test: /\\b(engine oil|lubricant|coolant|grease)\\b/i, emoji: '🛢️', tone: 'amber', label: 'Fluid', kind: 'oil' },
  { test: /\\b(tool|hammer|drill|spanner|screwdriver|pliers|wrench)\\b/i, emoji: '🛠️', tone: 'slate', label: 'Tools', kind: 'tools' },
  { test: /\\b(generator|inverter|transformer)\\b/i, emoji: '⚡', tone: 'amber', label: 'Power equipment', kind: 'generator' },
  { test: /\\b(solar)\\b/i, emoji: '☀️', tone: 'amber', label: 'Solar', kind: 'generator' },
  { test: /\\b(pipe|plumbing|tap|pump)\\b/i, emoji: '🚰', tone: 'cyan', label: 'Plumbing', kind: 'plumbing' },
  { test: /\\b(paint|primer|varnish|brush|roller)\\b/i, emoji: '🎨', tone: 'rose', label: 'Paint', kind: 'paint' },
  { test: /\\b(bulb|lamp|light|led|floodlight)\\b/i, emoji: '💡', tone: 'amber', label: 'Lighting', kind: 'lighting' },
  { test: /\\b(chair|table|desk|sofa|couch|cabinet|furniture)\\b/i, emoji: '🪑', tone: 'amber', label: 'Furniture', kind: 'furniture' },
  { test: /\\b(bed|mattress|pillow|duvet)\\b/i, emoji: '🛏️', tone: 'blue', label: 'Bedding', kind: 'bedding' },
  { test: /\\b(curtain|carpet|rug|mat)\\b/i, emoji: '🧵', tone: 'rose', label: 'Textile', kind: 'textile' },
  { test: /\\b(soap|detergent|cleaner|bleach|disinfectant)\\b/i, emoji: '🧼', tone: 'cyan', label: 'Cleaning', kind: 'cleaning' },
  { test: /\\b(tissue|toilet paper|napkin|paper towel)\\b/i, emoji: '🧻', tone: 'slate', label: 'Paper', kind: 'tissue' },
  { test: /\\b(pot|pan|utensil|cutlery|kettle|stove|cooker)\\b/i, emoji: '🍳', tone: 'slate', label: 'Kitchenware', kind: 'kitchenware' },
  { test: /\\b(plate|cup|mug|bowl|glass)\\b/i, emoji: '🍽️', tone: 'slate', label: 'Tableware', kind: 'tableware' },
  { test: /\\b(book|notebook|diary|journal)\\b/i, emoji: '📚', tone: 'blue', label: 'Books', kind: 'book' },
  { test: /\\b(pen|pencil|marker|crayon)\\b/i, emoji: '✏️', tone: 'amber', label: 'Stationery', kind: 'stationery' },
  { test: /\\b(paper|printing|photocopy|scan)\\b/i, emoji: '📄', tone: 'slate', label: 'Printing', kind: 'printing' },
  { test: /\\b(envelope|stamp|courier|delivery|shipping)\\b/i, emoji: '✉️', tone: 'slate', label: 'Mail', kind: 'mail' },
  { test: /\\b(folder|file|binder)\\b/i, emoji: '📁', tone: 'amber', label: 'Filing', kind: 'folder' },
  { test: /\\b(calculator)\\b/i, emoji: '🧮', tone: 'slate', label: 'Calculator', kind: 'calculator' },
  { test: /\\b(haircut|barber|salon|styling|braids|weave)\\b/i, emoji: '✂️', tone: 'pink', label: 'Salon', kind: 'salon' },
  { test: /\\b(repair|service|servicing|maintenance|installation)\\b/i, emoji: '🔧', tone: 'slate', label: 'Service', kind: 'repair' },
  { test: /\\b(ticket|fare|bus|transport|trip)\\b/i, emoji: '🎫', tone: 'cyan', label: 'Ticket', kind: 'ticket' },
  { test: /\\b(subscription|membership|renewal)\\b/i, emoji: '🔁', tone: 'emerald', label: 'Subscription', kind: 'subscription' },
  { test: /\\b(medicine|paracetamol|panadol|antibiotic|painkiller|syrup|vitamin)\\b/i, emoji: '💊', tone: 'teal', label: 'Medicine', kind: 'medicine' },
  { test: /\\b(syringe|vaccine|injection|needle)\\b/i, emoji: '💉', tone: 'teal', label: 'Medical', kind: 'syringe' },
  { test: /\\b(bandage|plaster|dressing|gauze)\\b/i, emoji: '🩹', tone: 'teal', label: 'First aid', kind: 'bandage' },
  { test: /\\b(mask|sanitizer|hand wash)\\b/i, emoji: '🧴', tone: 'teal', label: 'Hygiene', kind: 'hygiene' },
  { test: /\\b(lotion|cream|cosmetic|makeup|make-up|lipstick|foundation)\\b/i, emoji: '💄', tone: 'pink', label: 'Beauty', kind: 'cosmetics' },
  { test: /\\b(toothbrush|toothpaste|dental|mouthwash)\\b/i, emoji: '🪥', tone: 'cyan', label: 'Dental', kind: 'dental' },
  { test: /\\b(diaper|nappy|nappies)\\b/i, emoji: '🧷', tone: 'pink', label: 'Nappies', kind: 'nappy' },
  { test: /\\b(baby|infant|newborn|toddler)\\b/i, emoji: '👶', tone: 'pink', label: 'Baby', kind: 'baby' },
  { test: /\\b(formula|baby milk|feeding bottle|bottle)\\b/i, emoji: '🍼', tone: 'pink', label: 'Feeding', kind: 'feeding' },
  { test: /\\b(toy|lego|doll|puzzle|teddy)\\b/i, emoji: '🧸', tone: 'amber', label: 'Toy', kind: 'toy' },
  { test: /\\b(pram|stroller|pushchair|car seat)\\b/i, emoji: '🚼', tone: 'pink', label: 'Baby gear', kind: 'pram' },
  { test: /\\b(car|vehicle|truck|bakkie|suv)\\b/i, emoji: '🚗', tone: 'blue', label: 'Vehicle', kind: 'car' },
  { test: /\\b(fuel|petrol|diesel|gasoline)\\b/i, emoji: '⛽', tone: 'amber', label: 'Fuel', kind: 'fuel' },
  { test: /\\b(motorbike|motorcycle|bike|bicycle|scooter)\\b/i, emoji: '🏍️', tone: 'orange', label: 'Motorbike', kind: 'motorbike' },
  { test: /\\b(chicken|drumstick|wing|poultry|broiler|gizzard)\\b/i, emoji: '🍗', tone: 'amber', label: 'Chicken', kind: 'chicken' },
  { test: /\\b(burger|hamburger|cheeseburger)\\b/i, emoji: '🍔', tone: 'orange', label: 'Burger', kind: 'burger' },
  { test: /\\b(pizza|margherita|pepperoni)\\b/i, emoji: '🍕', tone: 'orange', label: 'Pizza', kind: 'pizza' },
  { test: /\\b(fries|fry|chips|wedges)\\b/i, emoji: '🍟', tone: 'amber', label: 'Fries', kind: 'fries' },
  { test: /\\b(hot ?dog|sausage|boerewors|vienna)\\b/i, emoji: '🌭', tone: 'rose', label: 'Sausage', kind: 'hotdog' },
  { test: /\\b(sandwich|sub|wrap|toastie)\\b/i, emoji: '🥪', tone: 'amber', label: 'Sandwich', kind: 'sandwich' },
  { test: /\\b(taco)\\b/i, emoji: '🌮', tone: 'amber', label: 'Taco', kind: 'taco' },
  { test: /\\b(burrito)\\b/i, emoji: '🌯', tone: 'amber', label: 'Burrito', kind: 'burrito' },
  { test: /\\b(salad|coleslaw)\\b/i, emoji: '🥗', tone: 'emerald', label: 'Salad', kind: 'salad' },
  { test: /\\b(rice|sadza|pap|pilau|biryani)\\b/i, emoji: '🍚', tone: 'amber', label: 'Rice', kind: 'rice' },
  { test: /\\b(noodles|pasta|spaghetti|macaroni|lasagne)\\b/i, emoji: '🍝', tone: 'orange', label: 'Pasta', kind: 'pasta' },
  { test: /\\b(soup|broth|stew|curry)\\b/i, emoji: '🍲', tone: 'orange', label: 'Soup', kind: 'soup' },
  { test: /\\b(bread|loaf|bun|roll|baguette)\\b/i, emoji: '🍞', tone: 'amber', label: 'Bakery', kind: 'bread' },
  { test: /\\b(cake|cupcake|cheesecake)\\b/i, emoji: '🍰', tone: 'pink', label: 'Cake', kind: 'cake' },
  { test: /\\b(donut|doughnut)\\b/i, emoji: '🍩', tone: 'pink', label: 'Donut', kind: 'donut' },
  { test: /\\b(cookie|biscuit)\\b/i, emoji: '🍪', tone: 'amber', label: 'Biscuit', kind: 'cookie' },
  { test: /\\b(pie|tart)\\b/i, emoji: '🥧', tone: 'amber', label: 'Pie', kind: 'pie' },
  { test: /\\b(ice ?cream|gelato|sundae|yoghurt|yogurt)\\b/i, emoji: '🍦', tone: 'pink', label: 'Ice cream', kind: 'icecream' },
  { test: /\\b(fish|tilapia|bream|hake|sardine|tuna)\\b/i, emoji: '🐟', tone: 'cyan', label: 'Fish', kind: 'fish' },
  { test: /\\b(meat|steak|beef|pork|lamb|mutton|fillet)\\b/i, emoji: '🥩', tone: 'rose', label: 'Meat', kind: 'meat' },
  { test: /\\b(bacon|ham)\\b/i, emoji: '🥓', tone: 'rose', label: 'Bacon', kind: 'bacon' },
  { test: /\\b(egg|omelette|omelet)\\b/i, emoji: '🥚', tone: 'amber', label: 'Eggs', kind: 'egg' },
  { test: /\\b(shrimp|prawn|calamari|seafood)\\b/i, emoji: '🍤', tone: 'orange', label: 'Seafood', kind: 'seafood' },
  { test: /\\b(popcorn|snack|crisps|niknaks)\\b/i, emoji: '🍿', tone: 'amber', label: 'Snacks', kind: 'snacks' },
  { test: /\\b(chocolate|cocoa)\\b/i, emoji: '🍫', tone: 'orange', label: 'Chocolate', kind: 'chocolate' },
  { test: /\\b(candy|sweet|lollipop|mint)\\b/i, emoji: '🍬', tone: 'pink', label: 'Sweets', kind: 'candy' },
  { test: /\\b(apple|banana|orange|mango|avocado|fruit)\\b/i, emoji: '🍎', tone: 'rose', label: 'Fruit', kind: 'fruit' },
  { test: /\\b(cereal|porridge|oats|muesli|granola)\\b/i, emoji: '🥣', tone: 'amber', label: 'Cereal', kind: 'cereal' },
  { test: /\\b(honey|jam|peanut butter|spread)\\b/i, emoji: '🍯', tone: 'amber', label: 'Spread', kind: 'spread' },
  { test: /\\b(coffee|espresso|latte|cappuccino|americano|mocha)\\b/i, emoji: '☕', tone: 'amber', label: 'Coffee', kind: 'coffee' },
  { test: /\\b(tea|rooibos|chai)\\b/i, emoji: '🍵', tone: 'emerald', label: 'Tea', kind: 'tea' },
  { test: /\\b(soda|soft drink|cola|coke|pepsi|fanta|sprite)\\b/i, emoji: '🥤', tone: 'rose', label: 'Soft drink', kind: 'soda' },
  { test: /\\b(water)\\b/i, emoji: '💧', tone: 'cyan', label: 'Water', kind: 'water' },
  { test: /\\b(juice|nectar|smoothie)\\b/i, emoji: '🧃', tone: 'orange', label: 'Juice', kind: 'juice' },
  { test: /\\b(beer|lager|ale|cider)\\b/i, emoji: '🍺', tone: 'amber', label: 'Beer', kind: 'beer' },
  { test: /\\b(wine)\\b/i, emoji: '🍷', tone: 'rose', label: 'Wine', kind: 'wine' },
  { test: /\\b(whisky|whiskey|gin|vodka|rum|brandy|spirits|liqueur)\\b/i, emoji: '🥃', tone: 'amber', label: 'Spirits', kind: 'spirits' },
  { test: /\\b(milk|dairy|cream|amasi)\\b/i, emoji: '🥛', tone: 'cyan', label: 'Dairy', kind: 'milk' },
  { test: /\\b(energy drink|red bull|monster)\\b/i, emoji: '🥤', tone: 'violet', label: 'Energy drink', kind: 'energy' },

  { test: /\\b(voucher|coupon|gift card|airtime)\\b/i, emoji: '🎫', tone: 'cyan', label: 'Voucher', kind: 'voucher' },
  { test: /\\b(internet|wifi|wi-fi|broadband|fibre|fiber)\\b/i, emoji: '🌐', tone: 'cyan', label: 'Internet', kind: 'internet' },
  { test: /\\b(printer ink|toner|cartridge)\\b/i, emoji: '🖨️', tone: 'slate', label: 'Ink', kind: 'ink' },
  { test: /\\b(screw|nail|bolt|nut|washer)\\b/i, emoji: '🔩', tone: 'slate', label: 'Fastener', kind: 'fastener' },
  { test: /\\b(glue|adhesive|tape|sealant)\\b/i, emoji: '🧷', tone: 'slate', label: 'Adhesive', kind: 'adhesive' },
  { test: /\\b(battery charger|jump starter)\\b/i, emoji: '🔋', tone: 'emerald', label: 'Charger', kind: 'charger' },
  { test: /\\b(fan|heater|aircon|air conditioner|cooler)\\b/i, emoji: '❄️', tone: 'cyan', label: 'Climate', kind: 'climate' },
  { test: /\\b(fridge|freezer|microwave|oven)\\b/i, emoji: '🧊', tone: 'cyan', label: 'Appliance', kind: 'appliance' },
  { test: /\\b(washing machine|laundry)\\b/i, emoji: '🧺', tone: 'cyan', label: 'Laundry', kind: 'laundry' },
  { test: /\\b(vacuum|broom|mop|dustpan)\\b/i, emoji: '🧹', tone: 'cyan', label: 'Cleaning tool', kind: 'cleaning' },

  // Bags/accessories come first: "laptop bag" is a bag, not a laptop, and
  // "baby bag" is a bag, not a baby product. The more specific container noun
  // must beat the device or contents it is named after.
  { test: /\b(bag|bags|handbag|handbags|backpack|backpacks|luggage|suitcase|purse|tote|shopping bag|laptop bag|phone bag)\b/i, emoji: '👜', tone: 'rose', label: 'Bag', kind: 'bag' },

  // ── Fast food & kitchen ────────────────────────────────────────────────
  { test: /\b(chicken|drumstick|drumsticks|wing|wings|poultry|broiler|gizzard|gizzards)\b/i, emoji: '🍗', tone: 'amber', label: 'Chicken', kind: 'chicken' },
  { test: /\b(burger|burgers|hamburger|cheeseburger|beefburger|whopper)\b/i, emoji: '🍔', tone: 'orange', label: 'Burger', kind: 'burger' },
  { test: /\b(pizza|pizzas|margherita|pepperoni)\b/i, emoji: '🍕', tone: 'orange', label: 'Pizza', kind: 'pizza' },
  { test: /\b(fries|fry|chips|french fries|wedges)\b/i, emoji: '🍟', tone: 'amber', label: 'Fries', kind: 'fries' },
  { test: /\b(hot ?dog|hotdog|sausage|sausages|boerewors|vienna)\b/i, emoji: '🌭', tone: 'rose', label: 'Sausage', kind: 'hotdog' },
  { test: /\b(sandwich|sandwiches|sub|subs|wrap|wraps|toastie)\b/i, emoji: '🥪', tone: 'amber', label: 'Sandwich', kind: 'sandwich' },
  { test: /\b(taco|tacos)\b/i, emoji: '🌮', tone: 'amber', label: 'Taco', kind: 'taco' },
  { test: /\b(burrito|burritos)\b/i, emoji: '🌯', tone: 'amber', label: 'Burrito', kind: 'burrito' },
  { test: /\b(salad|salads|greens|coleslaw)\b/i, emoji: '🥗', tone: 'emerald', label: 'Salad', kind: 'salad' },
  { test: /\b(rice|sadza|pap|pilau|pilaf|biryani)\b/i, emoji: '🍚', tone: 'amber', label: 'Rice', kind: 'rice' },
  { test: /\b(noodles|noodle|pasta|spaghetti|macaroni|lasagne|lasagna)\b/i, emoji: '🍝', tone: 'orange', label: 'Pasta', kind: 'pasta' },
  { test: /\b(soup|broth|stew|curry)\b/i, emoji: '🍲', tone: 'orange', label: 'Soup', kind: 'soup' },
  { test: /\b(bread|loaf|loaves|bun|buns|roll|rolls|baguette)\b/i, emoji: '🍞', tone: 'amber', label: 'Bakery', kind: 'bread' },
  { test: /\b(cake|cakes|cupcake|cupcakes|gateau|cheesecake)\b/i, emoji: '🍰', tone: 'pink', label: 'Cake', kind: 'cake' },
  { test: /\b(donut|donuts|doughnut|doughnuts)\b/i, emoji: '🍩', tone: 'pink', label: 'Donut', kind: 'donut' },
  { test: /\b(cookie|cookies|biscuit|biscuits|cookie)\b/i, emoji: '🍪', tone: 'amber', label: 'Biscuit', kind: 'cookie' },
  { test: /\b(pie|pies|tart|tarts)\b/i, emoji: '🥧', tone: 'amber', label: 'Pie', kind: 'pie' },
  { test: /\b(ice ?cream|gelato|sundae|yoghurt|yogurt)\b/i, emoji: '🍦', tone: 'pink', label: 'Ice cream', kind: 'icecream' },
  { test: /\b(fish|tilapia|bream|hake|sardine|sardines|tuna)\b/i, emoji: '🐟', tone: 'cyan', label: 'Fish', kind: 'fish' },
  { test: /\b(meat|steak|beef|pork|lamb|mutton|fillet)\b/i, emoji: '🥩', tone: 'rose', label: 'Meat', kind: 'meat' },
  { test: /\b(bacon|ham|rasher|rashers)\b/i, emoji: '🥓', tone: 'rose', label: 'Bacon', kind: 'bacon' },
  { test: /\b(egg|eggs|omelette|omelet)\b/i, emoji: '🥚', tone: 'amber', label: 'Eggs', kind: 'egg' },
  { test: /\b(shrimp|prawn|prawns|calamari|seafood)\b/i, emoji: '🍤', tone: 'orange', label: 'Seafood', kind: 'seafood' },
  { test: /\b(popcorn|snack|snacks|crisps|niknaks)\b/i, emoji: '🍿', tone: 'amber', label: 'Snacks', kind: 'snacks' },
  { test: /\b(chocolate|chocolates|cocoa|bar one|kitkat)\b/i, emoji: '🍫', tone: 'orange', label: 'Chocolate', kind: 'chocolate' },
  { test: /\b(candy|candies|sweet|sweets|lollipop|mint|mints)\b/i, emoji: '🍬', tone: 'pink', label: 'Sweets', kind: 'candy' },
  { test: /\b(apple|apples|banana|bananas|orange|oranges|fruit|fruits|mango|avocado)\b/i, emoji: '🍎', tone: 'rose', label: 'Fruit', kind: 'fruit' },
  { test: /\b(cereal|porridge|oats|muesli|granola)\b/i, emoji: '🥣', tone: 'amber', label: 'Cereal', kind: 'cereal' },
  { test: /\b(honey|jam|peanut butter|spread)\b/i, emoji: '🍯', tone: 'amber', label: 'Spread', kind: 'spread' },

  // ── Drinks ─────────────────────────────────────────────────────────────
  { test: /\b(water tank|water pump|water filter|plumbing)\b/i, emoji: '🚰', tone: 'cyan', label: 'Plumbing', kind: 'plumbing' },
  { test: /\b(coffee|espresso|latte|cappuccino|americano|mocha|macchiato)\b/i, emoji: '☕', tone: 'amber', label: 'Coffee', kind: 'coffee' },
  { test: /\b(tea|teas|rooibos|chai|green tea)\b/i, emoji: '🍵', tone: 'emerald', label: 'Tea', kind: 'tea' },
  { test: /\b(soda|soft drink|cola|coke|pepsi|fanta|sprite|stoney|schweppes)\b/i, emoji: '🥤', tone: 'rose', label: 'Soft drink', kind: 'soda' },
  { test: /\b(water|mineral water|still water|sparkling water)\b/i, emoji: '💧', tone: 'cyan', label: 'Water', kind: 'water' },
  { test: /\b(juice|juices|nectar|smoothie|smoothies)\b/i, emoji: '🧃', tone: 'orange', label: 'Juice', kind: 'juice' },
  { test: /\b(beer|beers|lager|ale|cider|castle|heineken|zambezi)\b/i, emoji: '🍺', tone: 'amber', label: 'Beer', kind: 'beer' },
  { test: /\b(wine|wines|red wine|white wine|rose wine)\b/i, emoji: '🍷', tone: 'rose', label: 'Wine', kind: 'wine' },
  { test: /\b(whisky|whiskey|gin|vodka|rum|brandy|spirits|liqueur)\b/i, emoji: '🥃', tone: 'amber', label: 'Spirits', kind: 'spirits' },
  { test: /\b(milk|dairy|cream|amasi)\b/i, emoji: '🥛', tone: 'cyan', label: 'Dairy', kind: 'milk' },
  { test: /\b(energy drink|red bull|monster|powerade|gatorade)\b/i, emoji: '🥤', tone: 'violet', label: 'Energy drink', kind: 'energy' },

  // ── Technology ─────────────────────────────────────────────────────────
  { test: /\b(laptop|laptops|notebook|notebooks|macbook|ultrabook|chromebook|vivobook|elitebook|omnibook|thinkpad|ideapad|pavilion|yoga|latitude|probook|surface)\b/i, emoji: '💻', tone: 'violet', label: 'Laptop', kind: 'laptop' },
  { test: /\b(phone|phones|smartphone|smartphones|iphone|samsung|galaxy|android|cellphone|mobile)\b/i, emoji: '📱', tone: 'blue', label: 'Phone', kind: 'phone' },
  { test: /\b(tablet|tablets|ipad|tab)\b/i, emoji: '📲', tone: 'blue', label: 'Tablet', kind: 'tablet' },
  { test: /\b(desktop|desktops|computer|computers|pc|monitor|monitors|screen|screens|display)\b/i, emoji: '🖥️', tone: 'violet', label: 'Computer', kind: 'desktop' },
  { test: /\b(tv|television|televisions|smart tv|led tv)\b/i, emoji: '📺', tone: 'violet', label: 'Television', kind: 'tv' },
  { test: /\b(camera|cameras|dslr|webcam|gopro)\b/i, emoji: '📷', tone: 'slate', label: 'Camera', kind: 'camera' },
  { test: /\b(headphone|headphones|earphone|earphones|earbuds|airpods|headset)\b/i, emoji: '🎧', tone: 'violet', label: 'Audio', kind: 'headphones' },
  { test: /\b(speaker|speakers|soundbar|subwoofer|bluetooth speaker)\b/i, emoji: '🔊', tone: 'violet', label: 'Speaker', kind: 'speaker' },
  { test: /\b(smart ?watch|smartwatch|watch|watches|apple watch)\b/i, emoji: '⌚', tone: 'blue', label: 'Watch', kind: 'watch' },
  { test: /\b(printer|printers|scanner|scanners|photocopier)\b/i, emoji: '🖨️', tone: 'slate', label: 'Printer', kind: 'printer' },
  { test: /\b(keyboard|keyboards)\b/i, emoji: '⌨️', tone: 'slate', label: 'Keyboard', kind: 'keyboard' },
  { test: /\b(mouse|mice|trackpad)\b/i, emoji: '🖱️', tone: 'slate', label: 'Mouse', kind: 'mouse' },
  { test: /\b(charger|chargers|adapter|adapters|power supply|psu)\b/i, emoji: '🔌', tone: 'amber', label: 'Charger', kind: 'charger' },
  { test: /\b(cable|cables|wire|wires|hdmi|usb cable|extension cord)\b/i, emoji: '🔗', tone: 'slate', label: 'Cable', kind: 'cable' },
  { test: /\b(battery|batteries|power bank|powerbank|inverter|ups)\b/i, emoji: '🔋', tone: 'emerald', label: 'Power', kind: 'battery' },
  { test: /\b(router|routers|wifi|wi-fi|modem|starlink|satellite|antenna|access point|hotspot)\b/i, emoji: '📡', tone: 'cyan', label: 'Connectivity', kind: 'router' },
  { test: /\b(sim card|simcard|airtime|data bundle|bundle|voucher|top ?up)\b/i, emoji: '📶', tone: 'cyan', label: 'Airtime & data', kind: 'airtime' },
  { test: /\b(hard drive|hard disk|ssd|usb|flash drive|memory card|storage)\b/i, emoji: '💾', tone: 'slate', label: 'Storage', kind: 'storage' },
  { test: /\b(playstation|xbox|nintendo|console|gaming|game|games|controller)\b/i, emoji: '🎮', tone: 'violet', label: 'Gaming', kind: 'gaming' },
  { test: /\b(drone|drones)\b/i, emoji: '🚁', tone: 'slate', label: 'Drone', kind: 'drone' },
  { test: /\b(projector|projectors)\b/i, emoji: '📽️', tone: 'violet', label: 'Projector', kind: 'projector' },

  // ── Home, hardware & tools ─────────────────────────────────────────────
  { test: /\b(bulb|bulbs|lamp|lamps|light|lights|led|floodlight)\b/i, emoji: '💡', tone: 'amber', label: 'Lighting', kind: 'lighting' },
  { test: /\b(chair|chairs|table|tables|sofa|sofas|couch|desk|furniture|cabinet)\b/i, emoji: '🪑', tone: 'amber', label: 'Furniture', kind: 'furniture' },
  { test: /\b(bed|beds|mattress|mattresses|pillow|pillows|duvet)\b/i, emoji: '🛏️', tone: 'blue', label: 'Bedding', kind: 'bedding' },
  { test: /\b(curtain|curtains|carpet|carpets|rug|rugs|mat|mats)\b/i, emoji: '🧵', tone: 'rose', label: 'Home textile', kind: 'textile' },
  { test: /\b(soap|detergent|cleaning|cleaner|bleach|disinfectant|dishwashing)\b/i, emoji: '🧼', tone: 'cyan', label: 'Cleaning', kind: 'cleaning' },
  { test: /\b(tissue|tissues|toilet paper|paper towel|napkin|napkins)\b/i, emoji: '🧻', tone: 'slate', label: 'Paper', kind: 'tissue' },
  { test: /\b(pot|pots|pan|pans|utensil|utensils|cutlery|kettle|stove|cooker)\b/i, emoji: '🍳', tone: 'slate', label: 'Kitchenware', kind: 'kitchenware' },
  { test: /\b(plate|plates|cup|cups|mug|mugs|bowl|bowls|glass|glasses)\b/i, emoji: '🍽️', tone: 'slate', label: 'Tableware', kind: 'tableware' },
  { test: /\b(tank|water tank|pump|pipe|pipes|tap|plumbing)\b/i, emoji: '🚰', tone: 'cyan', label: 'Plumbing', kind: 'plumbing' },
  { test: /\b(paint|paints|primer|varnish|brush|brushes|roller)\b/i, emoji: '🎨', tone: 'rose', label: 'Paint', kind: 'paint' },
  { test: /\b(tool|tools|hammer|drill|spanner|screwdriver|pliers|wrench|hardware)\b/i, emoji: '🛠️', tone: 'slate', label: 'Tools', kind: 'tools' },
  { test: /\b(generator|solar|solar panel|inverter|transformer)\b/i, emoji: '⚡', tone: 'amber', label: 'Power equipment', kind: 'generator' },

  // ── Fashion & personal ─────────────────────────────────────────────────
  { test: /\b(shirt|shirts|t-shirt|tshirt|tee|blouse|top|tops|jersey|hoodie)\b/i, emoji: '👕', tone: 'blue', label: 'Shirt', kind: 'shirt' },
  { test: /\b(trouser|trousers|pants|jeans|shorts|skirt|leggings)\b/i, emoji: '👖', tone: 'blue', label: 'Bottoms', kind: 'trousers' },
  { test: /\b(dress|dresses|gown|gowns|romper|rompers|rombas)\b/i, emoji: '👗', tone: 'pink', label: 'Dress', kind: 'dress' },
  { test: /\b(shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals|slipper|slippers)\b/i, emoji: '👟', tone: 'blue', label: 'Footwear', kind: 'shoes' },
  { test: /\b(hat|hats|cap|caps|beanie)\b/i, emoji: '🧢', tone: 'blue', label: 'Headwear', kind: 'hat' },
  { test: /\b(belt|belts|wallet|wallets)\b/i, emoji: '👛', tone: 'amber', label: 'Accessories', kind: 'wallet' },
  { test: /\b(sunglasses|glasses|spectacles|eyewear)\b/i, emoji: '🕶️', tone: 'slate', label: 'Eyewear', kind: 'glasses' },
  { test: /\b(jewellery|jewelry|ring|rings|necklace|necklaces|bracelet|bracelets|earring|earrings)\b/i, emoji: '💍', tone: 'amber', label: 'Jewellery', kind: 'jewellery' },
  { test: /\b(perfume|perfumes|fragrance|cologne|deodorant)\b/i, emoji: '🧴', tone: 'pink', label: 'Fragrance', kind: 'perfume' },

  // ── Health, beauty & baby ──────────────────────────────────────────────
  { test: /\b(medicine|medicines|tablet|tablets|pill|pills|paracetamol|panadol|antibiotic|painkiller|syrup|vitamin|vitamins)\b/i, emoji: '💊', tone: 'teal', label: 'Medicine', kind: 'medicine' },
  { test: /\b(syringe|syringes|vaccine|injection|needle)\b/i, emoji: '💉', tone: 'teal', label: 'Medical', kind: 'syringe' },
  { test: /\b(bandage|bandages|plaster|plasters|dressing|gauze)\b/i, emoji: '🩹', tone: 'teal', label: 'First aid', kind: 'bandage' },
  { test: /\b(mask|masks|face mask|sanitizer|sanitiser|hand wash)\b/i, emoji: '🧴', tone: 'teal', label: 'Hygiene', kind: 'hygiene' },
  { test: /\b(lotion|cream|creams|cosmetic|cosmetics|makeup|make-up|lipstick|foundation)\b/i, emoji: '💄', tone: 'pink', label: 'Beauty', kind: 'cosmetics' },
  { test: /\b(shampoo|conditioner|hair|haircare)\b/i, emoji: '🧴', tone: 'pink', label: 'Hair care', kind: 'shampoo' },
  { test: /\b(toothbrush|toothpaste|dental|mouthwash)\b/i, emoji: '🪥', tone: 'cyan', label: 'Dental', kind: 'dental' },
  { test: /\b(diaper|diapers|nappy|nappies|nappies)\b/i, emoji: '🧷', tone: 'pink', label: 'Nappies', kind: 'nappy' },
  { test: /\b(formula|baby milk|feeding bottle|bottle|bottles)\b/i, emoji: '🍼', tone: 'pink', label: 'Feeding', kind: 'feeding' },
  { test: /\b(baby|infant|newborn|toddler|rombas)\b/i, emoji: '👶', tone: 'pink', label: 'Baby', kind: 'baby' },
  { test: /\b(toy|toys|lego|doll|dolls|puzzle|puzzles|teddy)\b/i, emoji: '🧸', tone: 'amber', label: 'Toy', kind: 'toy' },
  { test: /\b(pram|stroller|pushchair|car seat)\b/i, emoji: '🚼', tone: 'pink', label: 'Baby gear', kind: 'pram' },

  // ── Automotive ─────────────────────────────────────────────────────────
  { test: /\b(tyre|tyres|tire|tires|wheel|wheels|rim|rims)\b/i, emoji: '🛞', tone: 'slate', label: 'Tyre', kind: 'tyre' },
  { test: /\b(car wash|valet|polish|wax)\b/i, emoji: '🧽', tone: 'cyan', label: 'Car care', kind: 'carcare' },
  { test: /\b(car|cars|vehicle|vehicles|truck|bakkie|suv)\b/i, emoji: '🚗', tone: 'blue', label: 'Vehicle', kind: 'car' },
  { test: /\b(fuel|petrol|diesel|gasoline|fill up)\b/i, emoji: '⛽', tone: 'amber', label: 'Fuel', kind: 'fuel' },
  { test: /\b(engine oil|oil|lubricant|grease|coolant|brake fluid)\b/i, emoji: '🛢️', tone: 'amber', label: 'Oil & fluids', kind: 'oil' },
  { test: /\b(spare part|spare parts|brake|clutch|filter|spark plug|battery)\b/i, emoji: '⚙️', tone: 'slate', label: 'Spare part', kind: 'sparepart' },
  { test: /\b(motorbike|motorcycle|bike|bicycle|scooter)\b/i, emoji: '🏍️', tone: 'orange', label: 'Motorbike', kind: 'motorbike' },

  // ── Office, stationery & services ──────────────────────────────────────
  { test: /\b(book|books|notebook|notebooks|exercise book|diary|journal)\b/i, emoji: '📚', tone: 'blue', label: 'Books', kind: 'book' },
  { test: /\b(pen|pens|pencil|pencils|marker|markers|crayon|crayons)\b/i, emoji: '✏️', tone: 'amber', label: 'Stationery', kind: 'stationery' },
  { test: /\b(paper|papers|printing|print|photocopy|copy|scan|scanning)\b/i, emoji: '📄', tone: 'slate', label: 'Printing', kind: 'printing' },
  { test: /\b(envelope|envelopes|stamp|stamps|courier|delivery|shipping)\b/i, emoji: '✉️', tone: 'slate', label: 'Mail & delivery', kind: 'mail' },
  { test: /\b(folder|folders|file|files|binder|stationery)\b/i, emoji: '📁', tone: 'amber', label: 'Filing', kind: 'folder' },
  { test: /\b(calculator|calculators)\b/i, emoji: '🧮', tone: 'slate', label: 'Calculator', kind: 'calculator' },
  { test: /\b(haircut|barber|salon|styling|braids|weave)\b/i, emoji: '✂️', tone: 'pink', label: 'Salon', kind: 'salon' },
  { test: /\b(repair|repairs|service|servicing|maintenance|installation)\b/i, emoji: '🔧', tone: 'slate', label: 'Service', kind: 'repair' },
  { test: /\b(ticket|tickets|fare|bus|transport|trip)\b/i, emoji: '🎫', tone: 'cyan', label: 'Ticket', kind: 'ticket' },
  { test: /\b(subscription|subscriptions|membership|renewal)\b/i, emoji: '🔁', tone: 'emerald', label: 'Subscription', kind: 'subscription' },
];

function haystack(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Resolve the best visual for a product. Name/category/SKU are checked before
 * the long description so a bag described as "fits a 14-inch laptop" still
 * reads as a bag.
 */
export function productVisual(product: {
  name?: string | null;
  category?: string | null;
  description?: string | null;
  sku?: string | null;
}): ProductVisual {
  const primary = haystack([product.name, product.category, product.sku]);
  const secondary = haystack([product.description]);

  for (const rule of RULES) {
    if (rule.test.test(primary)) {
      return { emoji: rule.emoji, tone: rule.tone, label: rule.label, kind: rule.kind };
    }
  }
  for (const rule of RULES) {
    if (rule.test.test(secondary)) {
      return { emoji: rule.emoji, tone: rule.tone, label: rule.label, kind: rule.kind };
    }
  }

  return { emoji: '📦', tone: 'slate', label: 'Product', kind: 'general' };
}
