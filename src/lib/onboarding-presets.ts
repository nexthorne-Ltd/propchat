export interface ArticleBlueprint {
  title: string;
  slug: string;
  summary: string;
  content: string;
}

export interface IndustryPreset {
  id: string;
  label: string;
  icon: string;
  sectionName: string;
  sectionSlug: string;
  sectionDescription: string;
  greetingTitle: string;
  greetingPlaceholder: string;
  articles: ArticleBlueprint[];
}

export const INDUSTRY_PRESETS: Record<string, IndustryPreset> = {
  generic: {
    id: 'generic',
    label: 'General / Other',
    icon: '💡',
    sectionName: 'Frequently Asked Questions',
    sectionSlug: 'faq',
    sectionDescription: 'Answers to common questions about our products, services, and policies.',
    greetingTitle: 'Support Team',
    greetingPlaceholder: 'We typically reply in under 5 minutes',
    articles: [
      {
        title: 'Getting Started with Our Service',
        slug: 'getting-started',
        summary: 'Everything you need to know about our services, support hours, and how to reach our team.',
        content: `# Getting Started\n\nWelcome! We are delighted to have you here. This guide provides an overview of our core services and how we assist our customers.\n\n## Our Availability\n\nOur support team is online Monday through Friday, 9:00 AM to 6:00 PM EST. During off-hours, you can leave a message here and we will reply via email.\n\n## Frequently Asked Inquiries\n\n- **How do I contact support?** Simply open the live chat widget in the bottom-right corner.\n- **Where can I view updates?** All announcements are posted on our main website and help center.`,
      },
      {
        title: 'Plans, Pricing & Invoicing',
        slug: 'pricing-and-invoicing',
        summary: 'Overview of our pricing structure, accepted payment methods, and invoice retrieval.',
        content: `# Plans, Pricing & Invoicing\n\nHere is everything you need to know regarding payments, billings, and account upgrades.\n\n## Accepted Payment Methods\n\nWe accept all major credit cards (Visa, MasterCard, American Express) and online invoice settlements.\n\n## Accessing Your Invoices\n\nReceipts are automatically emailed after every billing cycle. If you need custom VAT or tax information included on your invoice, please contact our billing department.`,
      },
      {
        title: 'Contacting Our Support Team',
        slug: 'contacting-support',
        summary: 'How to connect with our live specialists, escalate urgent requests, or request callbacks.',
        content: `# Contacting Support\n\nNeed assistance? Our customer care specialists are here to help.\n\n## Support Channels\n\n1. **Live Chat**: Click the chat bubble at the bottom right of any page for immediate answers.\n2. **Email Support**: Submit queries anytime and our team will get back to you within 24 business hours.\n3. **Knowledge Base**: Search this help center for self-serve troubleshooting anytime.`,
      },
    ],
  },
  saas: {
    id: 'saas',
    label: 'SaaS & Software',
    icon: '🚀',
    sectionName: 'Getting Started & API',
    sectionSlug: 'getting-started-api',
    sectionDescription: 'Guides, API documentation, and platform setup for developers and teams.',
    greetingTitle: 'Product Support',
    greetingPlaceholder: 'Ask us anything about our product, integrations, or API',
    articles: [
      {
        title: 'Quickstart: Platform Setup & Onboarding',
        slug: 'platform-quickstart',
        summary: 'Step-by-step instructions to create your organization, configure workspaces, and invite your team.',
        content: `# Platform Quickstart\n\nGet up and running with our software in less than five minutes.\n\n## 1. Workspace Configuration\nSet your organization name, default time zone, and security policies under Workspace Settings.\n\n## 2. Inviting Team Members\nInvite colleagues by navigating to Team Settings and specifying their roles (Admin, Member, or Billing Manager).\n\n## 3. Verify Your Integration\nTest your endpoints in sandbox mode before switching to production keys.`,
      },
      {
        title: 'API Keys & Webhook Configuration',
        slug: 'api-keys-and-webhooks',
        summary: 'How to generate API keys, secure your endpoints, and listen to real-time webhook events.',
        content: `# API Keys & Webhooks\n\nConnect our platform directly to your own tech stack using REST endpoints and webhooks.\n\n## API Key Security\n- Keep secret keys in environment variables; never commit them to client-side repositories.\n- Rotate keys immediately if compromised.\n\n## Webhooks\nConfigure your webhook URL in Developer Settings to receive real-time JSON payloads on state changes with signature verification.`,
      },
      {
        title: 'Managing Subscriptions, Seats & Billing',
        slug: 'subscriptions-and-seats',
        summary: 'How to upgrade tiers, purchase additional agent seats, and download tax invoices.',
        content: `# Subscriptions, Seats & Billing\n\nLearn how billing cycles, prorated upgrades, and seat licensing work.\n\n## Adding Team Seats\nAdding new seats calculates a prorated charge for the remaining days in your billing month.\n\n## Upgrades & Downgrades\nPlan upgrades take effect immediately with instant feature unlocking. Downgrades take effect at the end of the current billing cycle.`,
      },
    ],
  },
  ecommerce: {
    id: 'ecommerce',
    label: 'E-Commerce & Retail',
    icon: '🛍️',
    sectionName: 'Orders & Shipping',
    sectionSlug: 'orders-and-shipping',
    sectionDescription: 'Tracking orders, shipping timelines, and returns processing.',
    greetingTitle: 'Customer Care',
    greetingPlaceholder: 'Have questions about your order, shipping, or returns?',
    articles: [
      {
        title: 'Tracking Your Order & Delivery Times',
        slug: 'tracking-order-delivery',
        summary: 'Find your tracking number and understand our domestic and international delivery estimates.',
        content: `# Order Tracking & Delivery Times\n\nOnce your order ships, you will receive an email with a live tracking link.\n\n## Delivery Estimates\n- **Standard Domestic**: 3–5 business days\n- **Expedited Shipping**: 1–2 business days\n- **International**: 7–14 business days depending on customs clearance\n\nIf your tracking has not updated for more than 48 hours, reach out to our team in this chat!`,
      },
      {
        title: 'Returns, Refunds & Exchange Policy',
        slug: 'returns-and-refunds',
        summary: 'Our 30-day hassle-free return policy, return label generation, and refund timelines.',
        content: `# Returns & Refunds Policy\n\nWe want you to love your purchase! Items in original condition may be returned within 30 days of delivery.\n\n## Return Process\n1. Open our returns portal with your order number and zip code.\n2. Print the prepaid return label.\n3. Drop off the parcel at any authorized shipping carrier.\n\nRefunds are processed to the original payment method within 3–5 business days after inspection.`,
      },
      {
        title: 'Payment Options & Promo Codes',
        slug: 'payment-and-promo-codes',
        summary: 'Accepted payment methods, installments, and how to apply discount codes during checkout.',
        content: `# Payment Options & Promo Codes\n\nWe accept Visa, Mastercard, American Express, PayPal, and Apple Pay.\n\n## Using a Discount Code\nEnter your promo code at checkout in the 'Gift card or discount code' box and click Apply. Note that only one promo code can be applied per order.`,
      },
    ],
  },
  agency: {
    id: 'agency',
    label: 'Agency & Consulting',
    icon: '💼',
    sectionName: 'Client Services & Scope',
    sectionSlug: 'client-services-scope',
    sectionDescription: 'Working with our agency, project deliverables, and consultation schedules.',
    greetingTitle: 'Client Success',
    greetingPlaceholder: 'Tell us about your project goals and timeline',
    articles: [
      {
        title: 'How We Work: Onboarding & Project Milestones',
        slug: 'onboarding-and-milestones',
        summary: 'An overview of our discovery phase, project kickoff, deliverables schedule, and review cycles.',
        content: `# How We Work\n\nEvery project follows our structured milestone framework to ensure high quality and clear alignment.\n\n## Phase 1: Discovery & Strategy\nWe gather requirements, audit existing assets, and align on measurable KPIs.\n\n## Phase 2: Design & Execution\nAgile sprints with weekly review calls and staging links for feedback.\n\n## Phase 3: Launch & Optimization\nFinal QA, production deployment, and post-launch performance monitoring.`,
      },
      {
        title: 'Scope of Work & Revision Policies',
        slug: 'scope-and-revisions',
        summary: 'What is included in client engagements, feedback turnaround times, and change orders.',
        content: `# Scope & Revision Policies\n\nTransparent communication is the cornerstone of our partnerships.\n\n## Revisions\nEach deliverable includes up to two rounds of consolidated revisions based on the agreed creative brief.\n\n## Scope Adjustments\nAny new features or requirements outside the original statement of work will be estimated separately as a change order.`,
      },
      {
        title: 'Scheduling Strategy & Review Calls',
        slug: 'scheduling-review-calls',
        summary: 'How to book time with your lead strategist, account executive, or technical director.',
        content: `# Scheduling Calls\n\nHave questions or need to review designs?\n\n- **Weekly Syncs**: Conducted every Tuesday via Google Meet or Zoom.\n- **Ad-Hoc Questions**: Send us a chat right here or email your dedicated account lead.\n- **Emergency Escalation**: Call our client hotline for urgent production issues.`,
      },
    ],
  },
  healthcare: {
    id: 'healthcare',
    label: 'Healthcare & Wellness',
    icon: '🩺',
    sectionName: 'Patient Care & Appointments',
    sectionSlug: 'patient-care-appointments',
    sectionDescription: 'Booking visits, patient portal navigation, and telehealth guidelines.',
    greetingTitle: 'Care Team',
    greetingPlaceholder: 'How can our care team assist you today?',
    articles: [
      {
        title: 'Scheduling & Rescheduling Appointments',
        slug: 'scheduling-appointments',
        summary: 'How to book in-person and telehealth consultations, cancel visits, and join waitlists.',
        content: `# Scheduling Appointments\n\nBook your consultation online through our patient portal or through this chat window.\n\n## Cancellation Policy\nPlease provide at least 24 hours notice for cancellations or rescheduling to avoid late cancellation fees and allow us to offer the slot to waitlisted patients.`,
      },
      {
        title: 'Accessing the Patient Portal & Records',
        slug: 'patient-portal-records',
        summary: 'How to log in to view lab results, doctor notes, and request prescription refills.',
        content: `# Patient Portal & Health Records\n\nOur secure patient portal gives you 24/7 access to your health history.\n\n## Portal Features\n- View lab results and doctor notes\n- Request prescription renewals\n- Message your physician securely\n- Complete pre-visit health questionnaires`,
      },
      {
        title: 'Insurance Coverage & Billing FAQs',
        slug: 'insurance-and-billing',
        summary: 'In-network insurance providers, copays, deductibles, and self-pay pricing.',
        content: `# Insurance & Billing FAQs\n\nWe accept most major insurance plans including Medicare, Blue Cross Blue Shield, Aetna, and UnitedHealthcare.\n\n## Copayments & Deductibles\nCopays are collected at the time of service. We also accept HSA (Health Savings Account) and FSA debit cards.`,
      },
    ],
  },
  education: {
    id: 'education',
    label: 'Education & EdTech',
    icon: '🎓',
    sectionName: 'Admissions & Coursework',
    sectionSlug: 'admissions-and-coursework',
    sectionDescription: 'Enrollment instructions, curriculum access, and student support.',
    greetingTitle: 'Admissions & Support',
    greetingPlaceholder: 'Ask us about admissions, courses, and schedules',
    articles: [
      {
        title: 'Enrollment & Admission Deadlines',
        slug: 'enrollment-deadlines',
        summary: 'How to submit your application, required documentation, and semester registration dates.',
        content: `# Enrollment & Admission Deadlines\n\nApplications are accepted on a rolling basis for Fall, Spring, and Summer cohorts.\n\n## Required Documents\n- Completed online application form\n- Official transcripts or certificates\n- Proof of language proficiency (if applicable)`,
      },
      {
        title: 'Accessing Course Materials & Portal',
        slug: 'accessing-course-materials',
        summary: 'How students access lecture videos, syllabi, assignment submissions, and grades.',
        content: `# Course Materials & Student Portal\n\nLog in with your student credentials to access class modules.\n\n## Technical Requirements\nWe recommend Google Chrome or Mozilla Firefox for video lessons and interactive quizzes. Technical support is available via live chat 7 days a week.`,
      },
      {
        title: 'Tuition, Financial Aid & Scholarships',
        slug: 'tuition-and-financial-aid',
        summary: 'Tuition fee structures, payment installments, and scholarship qualification guidelines.',
        content: `# Tuition & Financial Aid\n\nWe believe education should be accessible. Explore our flexible payment plans and merit scholarships.\n\n## Monthly Installments\nSpread tuition fees interest-free over 3, 6, or 12 monthly installments. Applications for merit aid close 4 weeks prior to term start.`,
      },
    ],
  },
  finance: {
    id: 'finance',
    label: 'Finance & Real Estate',
    icon: '💳',
    sectionName: 'Accounts & Verification',
    sectionSlug: 'accounts-verification',
    sectionDescription: 'Security protocols, KYC verification, and transaction support.',
    greetingTitle: 'Client Advisory',
    greetingPlaceholder: 'Ask us about our plans, security, and account setup',
    articles: [
      {
        title: 'Identity Verification (KYC) Requirements',
        slug: 'kyc-verification-requirements',
        summary: 'Documents needed to verify your account, compliance guidelines, and approval times.',
        content: `# Identity Verification (KYC)\n\nIn accordance with financial compliance and anti-money laundering (AML) laws, all new accounts require identity verification.\n\n## Required Verification Documents\n1. Valid government-issued photo ID (Passport, National ID, or Driver's License)\n2. Proof of address dated within the past 90 days (Utility bill or bank statement)\n\nApprovals typically complete within 1–2 business hours.`,
      },
      {
        title: 'Security, Encryption & Two-Factor Authentication',
        slug: 'security-and-two-factor-auth',
        summary: 'How we protect your funds and personal information with 256-bit encryption and 2FA.',
        content: `# Account Security & 2FA\n\nYour security is our highest priority.\n\n## Enabling Two-Factor Authentication (2FA)\nWe strongly recommend enabling authenticator app-based 2FA (Google Authenticator, Authy) from your Security Settings. We will never ask you for your 2FA code or password via chat.`,
      },
      {
        title: 'Transfer Limits, Fees & Settlements',
        slug: 'transfer-limits-and-fees',
        summary: 'Daily transaction limits, wire transfer processing times, and fee schedule.',
        content: `# Transfer Limits & Fees\n\nLearn about domestic ACH, SEPA, and wire transfer processing.\n\n## Settlement Windows\n- **ACH Transfers**: 1–3 business days\n- **Wire Transfers**: Same-day if submitted before 3:00 PM EST\n- **Internal Transfers**: Instant and fee-free`,
      },
    ],
  },
};

export function getIndustryPreset(industry?: string | null): IndustryPreset {
  if (!industry) return INDUSTRY_PRESETS.generic;
  const key = industry.toLowerCase().trim();
  return INDUSTRY_PRESETS[key] || INDUSTRY_PRESETS.generic;
}
