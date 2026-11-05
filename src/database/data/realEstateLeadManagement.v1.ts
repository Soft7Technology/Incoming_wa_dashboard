// Versioned library seed. Release future changes through a new migration.
type Node = { id: string; type: string; position: { x: number; y: number }; data: any };
type Edge = { id: string; source: string; target: string; label?: string; sourceHandle?: string; data?: any };
const nodes: Node[] = [];
const edges: Edge[] = [];
const connect = (source: string, target: string, handle?: string, label?: string) => edges.push({
  id: `${source}_${handle || 'next'}`, source, target,
  ...(handle ? { sourceHandle: handle, label, data: { sourceHandle: handle } } : {}),
});
function question(id: string, title: string, text: string, variable: string, x: number, y: number, next: string) {
  nodes.push({ id, type: 'message', position: { x, y }, data: { title, key: '@whatsapp/ask-question',
    attributes: { variable, message: { type: 'text', text: { body: text } } } } });
  connect(id, next);
}
function menu(id: string, title: string, text: string, variable: string, x: number, y: number,
  choices: Array<[string, string, string]>, list = false) {
  const options = choices.map(([value, label]) => ({ id: `${id}_${value}`, title: label }));
  nodes.push({ id, type: 'message', position: { x, y }, data: { title,
    key: list ? '@whatsapp/send-list-message' : '@whatsapp/send-button-message', attributes: {
      variable, choice_values: Object.fromEntries(choices.map(([value]) => [`${id}_${value}`, value])),
      fallback_message: 'Sorry, I did not understand that. Please choose an option below.',
      message: { type: 'interactive', interactive: { type: list ? 'list' : 'button', body: { text },
        action: list ? { button: 'Choose an option', sections: [{ title, rows: options }] }
          : { buttons: options.map(reply => ({ type: 'reply', reply })) } } },
    } } });
  choices.forEach(([value, label, target]) => connect(id, target, `${id}_${value}`, label));
}
function finish(id: string, title: string, text: string, x: number, y: number) {
  nodes.push({ id, type: 'message', position: { x, y }, data: { title, key: '@whatsapp/send-text-message',
    attributes: { message: { type: 'text', text: { body: `${text}\n\nFor assistance, contact {{support_contact}}.` } } } } });
}

nodes.push({ id: 'trigger', type: 'trigger', position: { x: 600, y: 0 }, data: {
  title: 'Incoming WhatsApp Message', key: '@whatsapp/on-message',
  attributes: { keywords: ['property', 'real estate', 'buy', 'rent', 'sell'],
    template_id: 'real-estate-lead-management', template_version: 1 },
} });
connect('trigger', 'menu');
menu('menu', 'Welcome', 'Hello! Welcome to {{business_name}}. How can we help you today?', 'intent', 600, 220, [
  ['buy', 'Buy Property', 'buy_property'], ['rent', 'Rent Property', 'rent_property'],
  ['sell', 'Sell Property', 'sell_property'], ['team', 'Talk to agent', 'team_name'],
], true);

menu('buy_property', 'Buy Property', 'What type of property are you looking for?', 'propertyType', 0, 480, [
  ['residential', 'Residential', 'buy_location'], ['commercial', 'Commercial', 'buy_location'], ['plot', 'Plot / Land', 'buy_location'],
]);
question('buy_location', 'Preferred Location', 'Which location are you interested in? For example: Mumbai, Thane or Navi Mumbai.', 'location', 0, 720, 'buy_budget');
menu('buy_budget', 'Buying Budget', 'What is your approximate buying budget?', 'budget', 0, 960, [
  ['below_50l', 'Below 50 Lakhs', 'buy_bhk'], ['50l_1cr', '50 Lakhs - 1 Crore', 'buy_bhk'],
  ['1_2cr', '1 - 2 Crores', 'buy_bhk'], ['2_5cr', '2 - 5 Crores', 'buy_bhk'], ['above_5cr', 'Above 5 Crores', 'buy_bhk'],
], true);
menu('buy_bhk', 'BHK Requirement', 'How many bedrooms are you looking for? Choose Not applicable for a commercial property or plot.', 'bhk', 0, 1200, [
  ['1bhk', '1 BHK', 'buy_timeline'], ['2bhk', '2 BHK', 'buy_timeline'], ['3bhk', '3 BHK', 'buy_timeline'],
  ['4bhk', '4 BHK', 'buy_timeline'], ['any', 'Any', 'buy_timeline'], ['not_applicable', 'Not applicable', 'buy_timeline'],
], true);
menu('buy_timeline', 'Buying Timeline', 'When are you planning to buy?', 'timeline', 0, 1440, [
  ['immediate', 'Immediately', 'lead_name'], ['one_month', 'Within 1 Month', 'lead_name'], ['three_months', 'Within 3 Months', 'lead_name'],
]);

menu('rent_property', 'Rent Property', 'What type of property do you want to rent?', 'propertyType', 600, 480, [
  ['flat', 'Flat', 'rent_location'], ['office', 'Office', 'rent_location'], ['shop', 'Shop', 'rent_location'],
]);
question('rent_location', 'Rental Location', 'Which location would you like to rent in? For example: Mumbai, Thane or Navi Mumbai.', 'location', 600, 720, 'rent_budget');
menu('rent_budget', 'Rental Budget', 'What is your monthly rental budget?', 'budget', 600, 960, [
  ['below_15k', 'Below 15K', 'rent_bhk'], ['15_30k', '15K - 30K', 'rent_bhk'],
  ['30_50k', '30K - 50K', 'rent_bhk'], ['above_50k', 'Above 50K', 'rent_bhk'],
], true);
menu('rent_bhk', 'Rental BHK', 'How many bedrooms do you need? Choose Not applicable for an office or shop.', 'bhk', 600, 1200, [
  ['1bhk', '1 BHK', 'rent_movein'], ['2bhk', '2 BHK', 'rent_movein'], ['3bhk', '3 BHK', 'rent_movein'],
  ['not_applicable', 'Not applicable', 'rent_movein'],
], true);
menu('rent_movein', 'Move-in Date', 'When do you want to move in?', 'moveInDate', 600, 1440, [
  ['immediate', 'Immediately', 'lead_name'], ['15_days', 'Within 15 Days', 'lead_name'], ['one_month', 'Within 1 Month', 'lead_name'],
]);

question('sell_property', 'Seller Details', 'Please share your property location.', 'propertyLocation', 1200, 480, 'sell_price');
question('sell_price', 'Expected Selling Price', 'What is your expected selling price?', 'expectedPrice', 1200, 720, 'sell_name');
question('sell_name', 'Seller Name', 'What name should our property consultant use?', 'leadName', 1200, 960, 'seller_complete');
finish('seller_complete', 'Seller Enquiry Recorded', 'Your property location and expected price are recorded in this chat. Our team can review your selling enquiry with you.', 1200, 1200);

question('lead_name', 'Lead Name', 'What name should our property consultant use?', 'leadName', 300, 1680, 'lead_next');
menu('lead_next', 'Next Steps', 'Your requirements are recorded. How would you like to proceed?', 'nextAction', 300, 1920, [
  ['matches', 'Request matches', 'property_request'], ['visit', 'Site Visit', 'site_visit_property'], ['agent', 'Talk to agent', 'human_handoff'],
]);
finish('property_request', 'Request Matching Properties', 'Your property preferences are recorded. Please contact our consultant to check matching listings, current prices and availability.', -300, 2160);
question('site_visit_property', 'Property for Visit', 'Which property or project would you like to visit? Share its name or reference, or say you need help choosing.', 'visitProperty', 300, 2160, 'site_visit_date');
question('site_visit_date', 'Site Visit Date', 'Which date would you prefer for your site visit?', 'visitDate', 300, 2400, 'site_visit_time');
menu('site_visit_time', 'Site Visit Time', 'Select your preferred time.', 'visitTime', 300, 2640, [
  ['morning', '10 AM - 1 PM', 'confirm_visit'], ['afternoon', '1 PM - 4 PM', 'confirm_visit'], ['evening', '4 PM - 7 PM', 'confirm_visit'],
]);
finish('confirm_visit', 'Site Visit Request Recorded', 'Your preferred property, date and time are recorded in this chat. Your site visit is pending confirmation by our team; it is not booked yet.', 300, 2880);
question('team_name', 'Contact Name', 'What is your name, and what would you like our property consultant to help with?', 'consultantRequest', 1800, 480, 'human_handoff');
finish('human_handoff', 'Contact Property Consultant', 'Your enquiry is recorded. You can continue this conversation with our property consultant.', 1800, 2160);

const template = {
  id: 'real-estate-lead-management', version: 1, category: 'real-estate', category_name: 'Real Estate',
  name: 'Real Estate Lead Management',
  description: 'Capture buyer, tenant and seller requirements, and collect site-visit requests for your property team.',
  language: 'en', editable: true, approval_status: 'platform_starter', meta_approved: false,
  channel: 'whatsapp', badge: 'Starter', tags: ['Real Estate', 'Lead management', 'Buy', 'Rent', 'Sell', 'Site visits'],
  highlights: [{ label: 'Buy, rent and sell branches' }, { label: 'Budget and location capture' }, { label: 'Site-visit requests' }],
  use_cases: ['Buyer qualification', 'Rental enquiries', 'Seller enquiries', 'Site-visit requests', 'Contact our team'],
  customization_fields: [
    { key: 'business_name', label: 'Business name', required: true, max_length: 100 },
    { key: 'support_contact', label: 'Support contact', required: false, max_length: 120 },
  ],
  setup_notes: [
    'Creates an unpublished draft. Select a receiving phone number and save before publishing. Use property, real estate, buy, rent or sell to start, or configure it as your default chatbot.',
    'The incoming-message service finds or creates the contact. Answers and menu selections are saved in chat session variables.',
    'Property matching, property cards, CRM lead creation, appointment creation and round-robin agent assignment require configured integrations. This starter collects requests for team follow-up and ends automation at completion.',
    'Buy and rent use separate location paths; seller enquiries go directly to the team rather than searching buyer listings.',
  ],
  nodes, edges,
};
export default template;
