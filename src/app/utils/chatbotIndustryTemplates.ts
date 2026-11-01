import type { IndustryTemplate, TemplateBranch } from './chatbotTemplates';

const branch = (id: string, title: string, questions: Array<[string, string]>, completion: string): TemplateBranch =>
  ({ id, title, questions, completion });

// Enquiry flows use the existing question/menu runtime. No external system is called.
export const additionalIndustryTemplates: IndustryTemplate[] = [
  {
    id: 'ecommerce-order-tracking', category: 'e-commerce', category_name: 'E-commerce',
    name: 'Order Tracking Enquiry', description: 'Collect order references and delivery enquiries for your support team.', keywords: ['track order'],
    branches: [
      branch('tracking', 'Track an order', [['reference', 'What is your order reference?'], ['email', 'Which contact email should our team use?']], 'Your tracking enquiry is recorded. Our team must check the order system for the latest delivery status.'),
      branch('delivery', 'Delivery problem', [['reference', 'What is your order reference?'], ['issue', 'Is the parcel delayed, missing or damaged? Please describe the issue.']], 'Your delivery issue is recorded for review. A replacement or refund requires store confirmation.'),
    ],
  },
  {
    id: 'ecommerce-return-exchange', category: 'e-commerce', category_name: 'E-commerce',
    name: 'Return and Exchange Enquiry', description: 'Collect purchase details and a return or exchange request.', keywords: ['return item'],
    branches: [
      branch('return', 'Request a return', [['reference', 'What is your order reference?'], ['item', 'Which item and purchase date does this concern?'], ['reason', 'Why would you like to return the item?']], 'Your request is recorded. Our team must check the return policy and item details before confirming eligibility.'),
      branch('exchange', 'Request an exchange', [['reference', 'What is your order reference?'], ['item', 'Which item do you have, and which size or variant would you prefer?']], 'Your exchange request is recorded. Stock and exchange terms require confirmation.'),
    ],
  },
  {
    id: 'ecommerce-bulk-orders', category: 'e-commerce', category_name: 'E-commerce',
    name: 'Bulk Order and Gifting', description: 'Capture quantities, customisation and delivery requirements for a quote.', keywords: ['bulk order', 'gifting'],
    branches: [
      branch('bulk', 'Bulk purchase', [['name', 'What is your name and company?'], ['product', 'Which products and quantities do you need?'], ['delivery', 'Which delivery city and date should we quote for?']], 'Your bulk order brief is recorded. Our team will need to confirm pricing, stock and delivery.'),
      branch('gifts', 'Corporate gifts', [['name', 'What is your name and company?'], ['brief', 'What occasion, quantity and budget do you have in mind?'], ['branding', 'Do you need branded packaging or a personal message?']], 'Your gifting brief is recorded for a quote. Production starts only after an agreed order.'),
    ],
  },
  {
    id: 'it-services-support', category: 'it-services', category_name: 'IT Services',
    name: 'IT Support Assistant', description: 'Capture technical issues and support callback preferences.', keywords: ['it support'],
    branches: [
      branch('incident', 'Report an issue', [['name', 'What is your name and company?'], ['system', 'Which device, service or application is affected?'], ['issue', 'Describe the problem and any non-sensitive error message. Do not send passwords or access tokens.']], 'Your issue is recorded in this chat. Our team must review it; a support ticket has not been created automatically.'),
      branch('callback', 'Request a callback', [['name', 'What is your name?'], ['contact', 'Which email or business phone should we use?'], ['time', 'What callback time and time zone do you prefer?']], 'Your callback preference is recorded. Our team must confirm the time.'),
    ],
  },
  {
    id: 'it-services-project-quote', category: 'it-services', category_name: 'IT Services',
    name: 'Website and App Project Brief', description: 'Collect project scope, budget and timing for a proposal.', keywords: ['project quote'],
    branches: [
      branch('website', 'Website project', [['business', 'What is your business and current website, if any?'], ['scope', 'Which pages, features and integrations do you need?'], ['timeline', 'What budget range and launch date do you have in mind?']], 'Your website brief is recorded. Pricing and delivery dates require an agreed proposal.'),
      branch('app', 'Application project', [['business', 'What is your business and who will use the application?'], ['scope', 'Which platforms and main features do you need?'], ['timeline', 'What budget range and launch date do you have in mind?']], 'Your application brief is recorded for a scope discussion.'),
    ],
  },
  {
    id: 'it-services-cloud-consultation', category: 'it-services', category_name: 'IT Services',
    name: 'Cloud and Security Consultation', description: 'Gather cloud migration and security review requirements.', keywords: ['cloud consultation'],
    branches: [
      branch('cloud', 'Cloud migration', [['company', 'What is your name and company?'], ['scope', 'Which workloads would you like to migrate? Do not share credentials.'], ['timeline', 'What migration goals and timeline should we discuss?']], 'Your migration brief is recorded. An assessment is needed before confirming scope and cost.'),
      branch('security', 'Security review', [['company', 'What is your name and company?'], ['scope', 'What systems or security review goals would you like to discuss? Do not share vulnerabilities or secrets here.']], 'Your consultation enquiry is recorded. Contact your security response team directly for an active incident.'),
    ],
  },
  {
    id: 'real-estate-buyer-enquiry', category: 'real-estate', category_name: 'Real Estate',
    name: 'Property Buyer Enquiry', description: 'Collect buyer requirements and preferred locations.', keywords: ['buy property'],
    branches: [
      branch('home', 'Find a home', [['name', 'What is your name?'], ['location', 'Which city or area interests you?'], ['requirements', 'What property type, size and budget do you prefer?'], ['timeline', 'When would you like to buy?']], 'Your preferences are recorded. Our team must confirm suitable listings, availability and prices.'),
      branch('commercial', 'Commercial property', [['name', 'What is your name and business?'], ['location', 'Which location and property use do you have in mind?'], ['requirements', 'What size, budget and buying timeline do you prefer?']], 'Your commercial property requirements are recorded for discussion.'),
    ],
  },
  {
    id: 'real-estate-visit-request', category: 'real-estate', category_name: 'Real Estate',
    name: 'Site and Virtual Tour Request', description: 'Collect property viewing preferences for team confirmation.', keywords: ['property tour'],
    branches: [
      branch('site', 'Request a site visit', [['name', 'What is your name?'], ['property', 'Which property or project would you like to visit?'], ['time', 'What date and time do you prefer?']], 'Your site visit preference is recorded. It is not booked until our team confirms availability.'),
      branch('virtual', 'Request a virtual tour', [['name', 'What is your name and contact email?'], ['property', 'Which property would you like to see?'], ['time', 'What date, time and time zone do you prefer?']], 'Your virtual tour preference is recorded. The viewing link and time require team confirmation.'),
    ],
  },
  {
    id: 'real-estate-rental-enquiry', category: 'real-estate', category_name: 'Real Estate',
    name: 'Rental Enquiry Assistant', description: 'Collect tenant preferences or property listing enquiries.', keywords: ['rent property'],
    branches: [
      branch('tenant', 'Find a rental', [['name', 'What is your name?'], ['location', 'Which area and property size do you prefer?'], ['budget', 'What monthly budget and move-in date do you have in mind?']], 'Your rental preferences are recorded. Availability, deposit and terms need confirmation.'),
      branch('landlord', 'List a rental', [['name', 'What is your name?'], ['property', 'What type of property and location would you like to list?'], ['availability', 'When is it available and what rent do you expect?']], 'Your listing enquiry is recorded. Our team must verify the property and agree the listing terms.'),
    ],
  },
  {
    id: 'finance-loan-enquiry', category: 'finance-banking', category_name: 'Finance and Banking',
    name: 'Loan Enquiry Assistant', description: 'Collect loan interests and arrange a discussion with an authorised team.', keywords: ['loan enquiry'],
    introduction: 'This chat collects enquiries and does not approve loans. Do not share account numbers, PINs, OTPs or documents here.',
    branches: [
      branch('loan', 'Discuss a loan', [['name', 'What is your name?'], ['purpose', 'What type of loan and approximate amount would you like to discuss?'], ['contact', 'Which email or business phone should our team use?']], 'Your enquiry is recorded. Eligibility, rates and approval are determined by the lender after its assessment.'),
      branch('callback', 'Request a callback', [['name', 'What is your name?'], ['time', 'What callback time and contact method do you prefer?']], 'Your callback preference is recorded for the authorised lending team.'),
    ],
  },
  {
    id: 'finance-investment-consultation', category: 'finance-banking', category_name: 'Finance and Banking',
    name: 'Investment Consultation Request', description: 'Arrange an adviser conversation about investment goals.', keywords: ['investment enquiry'],
    introduction: 'This chat arranges consultations; it does not recommend investments or promise returns.',
    branches: [
      branch('goals', 'Discuss my goals', [['name', 'What is your name?'], ['goal', 'Which goal would you like to discuss with an adviser?'], ['contact', 'Which email or phone should the adviser use?']], 'Your consultation enquiry is recorded. Discuss suitability, risks and fees with an authorised adviser before deciding.'),
      branch('appointment', 'Request appointment', [['name', 'What is your name?'], ['time', 'What date, time and contact method do you prefer?']], 'Your appointment preference is recorded and needs adviser confirmation.'),
    ],
  },
  {
    id: 'finance-tax-consultation', category: 'finance-banking', category_name: 'Finance and Banking',
    name: 'Tax Consultation Enquiry', description: 'Route personal or business tax enquiries to a qualified professional.', keywords: ['tax enquiry'],
    introduction: 'Please do not send tax IDs, bank details or tax documents in this chat.',
    branches: [
      branch('personal', 'Personal tax enquiry', [['name', 'What is your name?'], ['region', 'Which country or region and tax year does your enquiry concern?'], ['topic', 'What topic would you like to discuss with a tax professional?']], 'Your enquiry is recorded. A qualified professional must confirm the rules, documents and deadlines that apply to you.'),
      branch('business', 'Business tax enquiry', [['business', 'What is your business name and country or region?'], ['topic', 'Which business tax topic would you like to discuss?'], ['contact', 'Which contact email should our team use?']], 'Your business tax enquiry is recorded for a professional consultation.'),
    ],
  },
];
