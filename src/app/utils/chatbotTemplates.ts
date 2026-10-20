export interface TemplateBranch {
  id: string;
  title: string;
  questions: Array<[string, string]>;
  completion: string;
}
interface IndustryTemplate {
  category: string;
  category_name: string;
  name: string;
  description: string;
  keywords: string[];
  introduction?: string;
  branches: TemplateBranch[];
}

// Shared source templates are never edited by tenant requests. New copies get their own graph.
const industries: IndustryTemplate[] = [
  {
    category: 'real-estate', category_name: 'Real Estate', name: 'Property Enquiries',
    description: 'Qualify buyers and tenants, collect property details and request site visits.',
    keywords: ['property', 'real estate'], branches: [
      { id: 'buy', title: 'Buy a property', questions: [['name', 'What is your name?'], ['location', 'Which city or area are you considering?'], ['type', 'What property type and size are you looking for?'], ['budget', 'What is your approximate budget and buying timeline?']], completion: 'Your buying preferences are recorded in this chat. Ask our team to confirm suitable listings and current prices.' },
      { id: 'rent', title: 'Rent a property', questions: [['name', 'What is your name?'], ['location', 'Which area would you like to rent in?'], ['budget', 'What is your monthly budget?'], ['move_in', 'What property size and move-in date do you prefer?']], completion: 'Your rental preferences are recorded. Availability and terms need confirmation from our team.' },
      { id: 'visit', title: 'Request a site visit', questions: [['name', 'What is your name?'], ['property', 'Which property or project interests you?'], ['time', 'Which date and time would you prefer for a visit?']], completion: 'Your preferred site-visit details are recorded. A visit is not booked until our team confirms it.' },
    ],
  },
  {
    category: 'health-care', category_name: 'Health Care', name: 'Clinic Appointment Enquiries',
    description: 'Collect appointment preferences and clinic enquiries without clinical advice.',
    keywords: ['clinic', 'appointment'],
    introduction: 'This chat handles clinic enquiries, not diagnosis or emergency care. For urgent medical help, contact local emergency services.',
    branches: [
      { id: 'appointment', title: 'Request appointment', questions: [['name', 'What name should we use for this appointment enquiry?'], ['department', 'Which department or doctor would you like to see?'], ['time', 'Which date and time would you prefer?']], completion: 'Your appointment preference is recorded. Please wait for clinic confirmation before attending.' },
      { id: 'hours', title: 'Hours and location', questions: [['branch', 'Which clinic branch or city are you asking about?']], completion: 'Ask our clinic team to confirm the current opening hours, address and directions for your chosen branch.' },
      { id: 'services', title: 'Services and fees', questions: [['service', 'Which consultation or clinic service would you like information about?']], completion: 'Our clinic team can confirm service availability and current fees. Please do not send medical reports or sensitive health details here.' },
    ],
  },
  {
    category: 'e-commerce', category_name: 'E-commerce', name: 'Shopping and Order Support',
    description: 'Help customers explore products and submit order or return enquiries.',
    keywords: ['shop', 'order'], branches: [
      { id: 'products', title: 'Find a product', questions: [['category', 'Which product or category are you looking for?'], ['preferences', 'What size, variant or budget would you prefer?']], completion: 'Your product preferences are recorded. Ask our team for the catalogue, current stock and prices.' },
      { id: 'order', title: 'Order enquiry', questions: [['reference', 'What is your order reference? Do not share payment card details or passwords.'], ['question', 'What would you like to know about this order?']], completion: 'Your order enquiry is recorded. Order status must be checked by our team or your connected order system.' },
      { id: 'returns', title: 'Return or exchange', questions: [['reference', 'What is your order reference?'], ['item', 'Which item would you like to return or exchange, and why?']], completion: 'Your return or exchange enquiry is recorded. Eligibility, charges and next steps depend on the store policy and team confirmation.' },
    ],
  },
  {
    category: 'travel', category_name: 'Travel', name: 'Trip Planning Enquiries',
    description: 'Collect holiday, transport and itinerary preferences for a travel quote.',
    keywords: ['travel', 'trip'], branches: [
      { id: 'holiday', title: 'Plan a holiday', questions: [['name', 'What is your name?'], ['destination', 'Where would you like to travel from and to?'], ['dates', 'What are your preferred travel dates?'], ['group', 'How many travellers are there, and what is your approximate budget?']], completion: 'Your holiday preferences are recorded. Quotes, availability and bookings require confirmation from our travel team.' },
      { id: 'transport', title: 'Flight or transport', questions: [['route', 'What departure and arrival locations do you need?'], ['dates', 'What travel dates and number of passengers do you prefer?']], completion: 'Your transport enquiry is recorded. Fares and seats must be confirmed before any booking.' },
      { id: 'booking', title: 'Existing booking', questions: [['reference', 'What is your booking reference? Do not send passport copies or payment details.'], ['request', 'What help do you need with your booking?']], completion: 'Your booking enquiry is recorded. Changes and cancellation terms need confirmation from our team.' },
    ],
  },
  {
    category: 'digital-marketing', category_name: 'Digital Marketing', name: 'Agency Lead Qualification',
    description: 'Qualify advertising, SEO and social media enquiries before a consultation.',
    keywords: ['marketing', 'agency'], branches: [
      { id: 'ads', title: 'Advertising campaigns', questions: [['business', 'What is your business name and website, if available?'], ['goal', 'What would you like your advertising campaign to achieve?'], ['budget', 'What monthly advertising budget and start date do you have in mind?']], completion: 'Your advertising brief is recorded. Our team can discuss scope and a proposal; results are not guaranteed.' },
      { id: 'seo', title: 'SEO and website', questions: [['website', 'Which website would you like help with?'], ['goal', 'What website or search visibility goals would you like to discuss?']], completion: 'Your website and SEO enquiry is recorded for a scope discussion with our team.' },
      { id: 'social', title: 'Social media services', questions: [['business', 'What is your business and which social channels do you use?'], ['scope', 'Do you need content, account management, design or another service?'], ['timeline', 'What budget and timeline should our team consider?']], completion: 'Your social media brief is recorded. Deliverables and pricing need confirmation in a proposal.' },
    ],
  },
  {
    category: 'hotels-resorts', category_name: 'Hotels and Resorts', name: 'Stay and Event Enquiries',
    description: 'Collect room, event and existing-reservation enquiries.',
    keywords: ['hotel', 'stay'], branches: [
      { id: 'rooms', title: 'Room availability', questions: [['name', 'What is your name?'], ['dates', 'What check-in and check-out dates do you prefer?'], ['guests', 'How many adults, children and rooms should we consider?'], ['room', 'What room type or budget do you prefer?']], completion: 'Your stay preferences are recorded. Room availability, rates and reservations require confirmation from the property.' },
      { id: 'events', title: 'Wedding or event', questions: [['event', 'What type of event are you planning?'], ['date', 'What date and approximate guest count do you have in mind?'], ['requirements', 'What venue, catering or stay requirements would you like to discuss?']], completion: 'Your event enquiry is recorded. Our team can confirm availability and prepare a proposal.' },
      { id: 'reservation', title: 'Existing reservation', questions: [['reference', 'What is your reservation reference?'], ['request', 'What help do you need with your reservation?']], completion: 'Your reservation enquiry is recorded. Any changes must be confirmed by our reservations team.' },
    ],
  },
  {
    category: 'education', category_name: 'Education', name: 'Admissions and Course Enquiries',
    description: 'Collect course interests, admission questions and counselling preferences.',
    keywords: ['admission', 'courses'], branches: [
      { id: 'courses', title: 'Explore courses', questions: [['name', 'What is your name?'], ['interest', 'Which course or subject interests you?'], ['level', 'What level and preferred start period are you considering?']], completion: 'Your course interests are recorded. Ask our admissions team for the current prospectus and eligibility requirements.' },
      { id: 'fees', title: 'Fees and admissions', questions: [['course', 'Which programme and intake are you asking about?'], ['question', 'What would you like to know about fees, eligibility or the application process?']], completion: 'Your admissions enquiry is recorded. Fees, dates and eligibility must be confirmed by the institution.' },
      { id: 'counselling', title: 'Request counselling', questions: [['name', 'What name should our counselling team use?'], ['interest', 'Which programme would you like to discuss?'], ['time', 'What time would you prefer for a counselling conversation?']], completion: 'Your counselling preference is recorded. The session is not scheduled until our team confirms it.' },
    ],
  },
  {
    category: 'it-saas', category_name: 'IT Companies and SaaS', name: 'Software Sales and Support',
    description: 'Capture demo requests, project requirements and technical support enquiries.',
    keywords: ['software', 'demo'], branches: [
      { id: 'demo', title: 'Request a demo', questions: [['name', 'What is your name and company?'], ['use_case', 'Which product or use case would you like to explore?'], ['team_size', 'How many users would need access?'], ['time', 'What time would you prefer for a demo?']], completion: 'Your demo preferences are recorded. Our team must confirm the appointment and product suitability.' },
      { id: 'project', title: 'Discuss a project', questions: [['scope', 'What application, website or integration would you like to build?'], ['timeline', 'What timeline and approximate budget should we consider?']], completion: 'Your project brief is recorded. Scope, pricing and delivery dates require an agreed proposal.' },
      { id: 'support', title: 'Technical support', questions: [['product', 'Which product or account are you asking about? Do not share passwords or API keys.'], ['issue', 'Describe the issue and any non-sensitive error message you see.']], completion: 'Your support details are recorded in this chat. Contact our support team to have the issue reviewed.' },
    ],
  },
  {
    category: 'mlm-affiliates', category_name: 'MLM and Affiliates', name: 'Partner Programme Enquiries',
    description: 'Explain where to obtain programme information and collect partner enquiries.',
    keywords: ['affiliate', 'partner'],
    introduction: 'Programme eligibility, fees and compensation terms must be reviewed with our team. Participation does not guarantee earnings.',
    branches: [
      { id: 'programme', title: 'Programme information', questions: [['name', 'What is your name?'], ['interest', 'Which product or partner programme would you like information about?']], completion: 'Your interest is recorded. Request the official product details, eligibility criteria, fees, refund policy and programme terms before deciding.' },
      { id: 'apply', title: 'Partner application', questions: [['name', 'What is your name?'], ['region', 'Which country or region do you operate in?'], ['experience', 'What relevant product, sales or audience experience would you like to share?']], completion: 'Your application enquiry is recorded. This is not an acceptance or an earnings promise; our team must review eligibility and terms.' },
      { id: 'support', title: 'Existing partner help', questions: [['reference', 'What is your partner reference, if you have one?'], ['request', 'What product, account or programme question do you need help with?']], completion: 'Your partner support enquiry is recorded. Any account or compensation information must be verified by the authorised team.' },
    ],
  },
];

const metadata = (item: IndustryTemplate) => ({
  id: `${item.category}-starter`, version: 1, category: item.category, category_name: item.category_name,
  name: item.name, description: item.description, language: 'en', editable: true,
  approval_status: 'platform_starter', meta_approved: false,
  use_cases: [...item.branches.map(branch => branch.title), 'Contact our team'],
  customization_fields: [
    { key: 'business_name', label: 'Business name', required: true, max_length: 100 },
    { key: 'support_contact', label: 'Support contact', required: false, max_length: 120 },
  ],
  setup_notes: ['Creates an unpublished draft. Select a receiving phone number and save before publishing.',
    'Answers are stored in chat session variables. Add integrations for CRM, bookings, orders or ticket creation.'],
});

export function chatbotTemplateCategories() {
  return industries.map(item => ({ id: item.category, name: item.category_name, template_count: 1 }));
}

export function listChatbotTemplates(category?: string) {
  return industries.filter(item => category === undefined || item.category === category).map(metadata);
}

export function buildChatbotTemplate(id: string) {
  const item = industries.find(value => `${value.category}-starter` === id);
  if (!item) return undefined;
  const branches: TemplateBranch[] = [...item.branches, { id: 'team', title: 'Contact our team',
    questions: [['name', 'What is your name?'], ['request', 'What would you like our team to help with?']],
    completion: 'Thanks for sharing your enquiry. Our team can help you with the next steps.' }];
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: any }> = [
    { id: 'trigger', type: 'trigger', position: { x: 600, y: 0 }, data: { title: 'On Message', key: '@whatsapp/on-message',
      attributes: { keywords: [...item.keywords], template_id: id, template_version: 1 } } },
    { id: 'menu', type: 'message', position: { x: 600, y: 220 }, data: { title: 'Welcome menu',
      key: '@whatsapp/send-list-message', attributes: { message: { type: 'interactive', interactive: {
        type: 'list', body: { text: `Welcome to {{business_name}}. How can we help?${item.introduction ? `\n\n${item.introduction}` : ''}` },
        action: { button: 'Choose an option', sections: [{ title: 'How can we help?',
          rows: branches.map(branch => ({ id: `choice_${branch.id}`, title: branch.title })) }] },
      } } } } },
  ];
  const edges: Array<{ id: string; source: string; target: string; label?: string; sourceHandle?: string; data?: any }> = [
    { id: 'trigger_menu', source: 'trigger', target: 'menu' },
  ];
  for (const [column, branch] of branches.entries()) {
    const ids = branch.questions.map(([variable]) => `${branch.id}_${variable}`);
    for (const [index, [variable, question]] of branch.questions.entries()) {
      nodes.push({ id: ids[index], type: 'message', position: { x: column * 450, y: 480 + index * 240 },
        data: { title: `${branch.title}: ${variable}`, key: '@whatsapp/ask-question',
          attributes: { variable: ids[index], message: { type: 'text', text: { body: question } } } } });
    }
    const end = `${branch.id}_complete`;
    nodes.push({ id: end, type: 'message', position: { x: column * 450, y: 480 + ids.length * 240 },
      data: { title: `${branch.title}: next steps`, key: '@whatsapp/send-text-message',
        attributes: { message: { type: 'text', text: { body: `${branch.completion}\n\nFor assistance, contact {{support_contact}}.` } } } } });
    const handle = `choice_${branch.id}`;
    edges.push({ id: `menu_${branch.id}`, source: 'menu', target: ids[0], label: branch.title,
      sourceHandle: handle, data: { sourceHandle: handle } });
    for (const [index, source] of ids.entries()) edges.push({ id: `next_${source}`, source, target: ids[index + 1] ?? end });
  }
  return { ...metadata(item), nodes, edges };
}
