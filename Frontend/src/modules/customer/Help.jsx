import TopHeader from '../../components/shared/TopHeader';

const helpItems = [
  { id: 'faq', icon: 'help', label: 'FAQs', description: 'Find answers to common questions' },
  { id: 'chat', icon: 'chat', label: 'Live Chat', description: 'Chat with our support team' },
  { id: 'email', icon: 'mail', label: 'Email Support', description: 'support@onecapital.com' },
  { id: 'phone', icon: 'phone', label: 'Call Us', description: '+91 1800 123 4567' },
  { id: 'guide', icon: 'menu_book', label: 'User Guide', description: 'Learn how to use the app' },
  { id: 'feedback', icon: 'rate_review', label: 'Feedback', description: 'Share your experience' },
];

const Help = () => {
  return (
    <div className="min-h-screen bg-background-light dark:bg-[#050806]">
      <TopHeader title="Help & Support" showBack={true} />

      <div className="px-4 py-5">
        <div className="bg-gradient-to-br from-primary to-blue-600 rounded-2xl p-5 text-white mb-5">
          <h2 className="text-xl font-bold mb-2">How can we help?</h2>
          <p className="text-white/80 text-sm">Our support team is available 24/7 to assist you</p>
        </div>

        <div className="space-y-3">
          {helpItems.map((item) => (
            <button key={item.id} className="w-full flex items-center gap-4 p-4 bg-white dark:bg-[#111b17] rounded-xl border border-gray-100 dark:border-[#22352d] hover:shadow-md transition-shadow">
              <div className="w-12 h-12 bg-blue-50 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-primary">{item.icon}</span>
              </div>
              <div className="flex-1 text-left">
                <p className="font-semibold text-gray-900 dark:text-[#e8f3ee]">{item.label}</p>
                <p className="text-sm text-gray-500 dark:text-[#9cb7aa]">{item.description}</p>
              </div>
              <span className="material-symbols-outlined text-gray-400">chevron_right</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Help;