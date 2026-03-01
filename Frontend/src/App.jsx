import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import './App.css';

// Context Providers
import { AuthProvider, useAuth } from './context/AuthContext';
import { MarketDataProvider } from './context/SocketContext';
import { BrokerAuthProvider, useBrokerAuth } from './context/BrokerContext';
import { AdminAuthProvider, useAdminAuth } from './context/AdminContext';
import { useTheme } from './context/useTheme';

// Layouts
import CustomerLayout from './layouts/CustomerLayout';
import BrokerLayout from './layouts/BrokerLayout';
import CFDRiskWarningModal from './components/shared/CFDRiskWarningModal';

// Customer Modules - Main Pages
import Watchlist from './modules/customer/Watchlist';
import Orders from './modules/customer/Orders';
import Portfolio from './modules/customer/Portfolio';
import PortfolioInvoice from './modules/customer/PortfolioInvoice';
import Profile from './modules/customer/Profile';
import ProfileEdit from './modules/customer/ProfileEdit';
import Funds from './modules/customer/Funds';
import FundStatement from './modules/customer/FundStatement';
import AddFunds from './modules/customer/AddFunds';
import AddFundsConfirm from './modules/customer/AddFundsConfirm';
import WithdrawFunds from './modules/customer/WithdrawFunds';
import WithdrawalConfirm from './modules/customer/WithdrawalConfirm';
import Payments from './modules/customer/Payments';
import AccountSettings from './modules/customer/AccountSettings';
import AddBankAccount from './modules/customer/AddBankAccount';
import AccountSummary from './modules/customer/AccountSummary';
import Help from './modules/customer/Help';
import KycDetails from './modules/customer/KycDetails';
import KYCDocuments from './modules/customer/KYCDocuments';
import KYCPending from './modules/customer/KYCPending';
import OrderConfirmation from './modules/customer/OrderConfirmation';
import OptionChain from './modules/customer/OptionChain';
import ChartView from './modules/customer/ChartView';
import OrderBook from './modules/customer/OrderBook';

// Broker Modules
import BrokerLogin from './modules/broker/Login';
import BrokerDashboard from './modules/broker/Dashboard';
import BrokerClientList from './modules/broker/ClientList';
import BrokerClientDetail from './modules/broker/ClientDetail';
import BrokerFunds from './modules/broker/Funds';
import BrokerManagement from './modules/broker/Management';
import BrokerWithdrawalRequests from './modules/broker/WithdrawalRequests';
import BrokerApprovals from './modules/broker/Approvals';
import BrokerCncOrderApprovals from './modules/broker/CncOrderApprovals';
import BrokerSettings from './modules/broker/Settings';
import BrokerLogs from './modules/broker/Logs';
import BrokerPaymentVerification from './modules/broker/PaymentVerification';
import BrokerCreateClient from './modules/broker/CreateClient';
import BrokerEditClient from './modules/broker/EditClient';
import BrokerRecycleBin from './modules/broker/RecycleBin';

// Admin Modules
import AdminLogin from './modules/admin/Login';
import AdminDashboard from './modules/admin/Dashboard';
import AdminBrokers from './modules/admin/Brokers';
import AdminCustomers from './modules/admin/Customers';
import AdminKYC from './modules/admin/KYC';
import AdminLogs from './modules/admin/Logs';
import AdminAccessToken from './modules/admin/AccessToken';
import AdminSettings from './modules/admin/Settings';
import AdminReports from './modules/admin/Reports';
import AdminWithdrawals from './modules/admin/Withdrawals';
import AdminFunds from './modules/admin/Funds';

// Auth
import Login from './modules/auth/Login';
import Signup from './modules/auth/Signup';
import RegistrationStatus from './modules/auth/RegistrationStatus';

const CUSTOMER_CFD_WARNING_REQUIRED_KEY = 'customer_cfd_warning_required';

const AuthLoadingScreen = () => {
  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div
          className="h-10 w-10 rounded-full border-2 border-white/20 border-t-emerald-400 animate-spin"
          aria-hidden="true"
        />
        <p className="text-sm text-slate-300 tracking-wide">Checking session...</p>
      </div>
    </div>
  );
};

const LandingRoute = () => {
  const { isAuthenticated: customerAuthenticated, user: customerUser, loading: customerLoading } = useAuth();
  const { isAuthenticated: brokerAuthenticated, loading: brokerLoading } = useBrokerAuth();
  const { isAuthenticated: adminAuthenticated, loading: adminLoading } = useAdminAuth();

  if (customerLoading || brokerLoading || adminLoading) return <AuthLoadingScreen />;
  if (adminAuthenticated) return <Navigate to="/admin/dashboard" replace />;
  if (brokerAuthenticated) return <Navigate to="/broker/dashboard" replace />;
  if (customerAuthenticated) {
    return customerUser?.kycStatus === 'verified'
      ? <Navigate to="/watchlist" replace />
      : <Navigate to="/kyc-pending" replace />;
  }
  return <Navigate to="/login" replace />;
};

const CustomerCfdRiskWarningGate = () => {
  const { isAuthenticated, user } = useAuth();
  const [isDismissed, setIsDismissed] = useState(false);

  const isOpen = (() => {
    if (isDismissed || !isAuthenticated || !user) return false;
    try {
      return sessionStorage.getItem(CUSTOMER_CFD_WARNING_REQUIRED_KEY) === '1';
    } catch {
      return false;
    }
  })();

  const handleAgree = () => {
    try {
      sessionStorage.removeItem(CUSTOMER_CFD_WARNING_REQUIRED_KEY);
    } catch {
      // No-op: session storage may be unavailable in private mode.
    }
    setIsDismissed(true);
  };

  if (!isOpen) return null;

  return <CFDRiskWarningModal isOpen={isOpen} onAgree={handleAgree} />;
};

const RequireCustomerAuth = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <AuthLoadingScreen />;
  return isAuthenticated ? (
    <>
      {children}
      <CustomerCfdRiskWarningGate />
    </>
  ) : <Navigate to="/login" replace />;
};

// Gate trading routes behind KYC approval.
// Redirects to /kyc-pending if authenticated but trading is not yet enabled.
const RequireTradingEnabled = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <AuthLoadingScreen />;
  if (user?.kycStatus !== 'verified') return <Navigate to="/kyc-pending" replace />;
  return children;
};

const RequireBrokerAuth = ({ children }) => {
  const { isAuthenticated, loading } = useBrokerAuth();
  if (loading) return <AuthLoadingScreen />;
  return isAuthenticated ? children : <Navigate to="/broker/login" replace />;
};

const RequireAdminAuth = ({ children }) => {
  const { isAuthenticated, loading } = useAdminAuth();
  if (loading) return <AuthLoadingScreen />;
  return isAuthenticated ? children : <Navigate to="/admin/login" replace />;
};

const GuestOnlyRoute = ({ children }) => {
  const { isAuthenticated: customerAuthenticated, user: customerUser, loading: customerLoading } = useAuth();
  const { isAuthenticated: brokerAuthenticated, loading: brokerLoading } = useBrokerAuth();
  const { isAuthenticated: adminAuthenticated, loading: adminLoading } = useAdminAuth();

  if (customerLoading || brokerLoading || adminLoading) return <AuthLoadingScreen />;
  if (adminAuthenticated) return <Navigate to="/admin/dashboard" replace />;
  if (brokerAuthenticated) return <Navigate to="/broker/dashboard" replace />;
  if (customerAuthenticated) {
    return customerUser?.kycStatus === 'verified'
      ? <Navigate to="/watchlist" replace />
      : <Navigate to="/kyc-pending" replace />;
  }
  return children;
};

const RouteThemeEnforcer = () => {
  const { pathname } = useLocation();
  const { setForcedTheme } = useTheme();

  useEffect(() => {
    const isBrokerRoute = pathname === '/broker' || pathname.startsWith('/broker/');
    const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
    setForcedTheme(isBrokerRoute || isAdminRoute ? 'light' : null);
  }, [pathname, setForcedTheme]);

  return null;
};

function App() {
  return (
    <Router>
      <RouteThemeEnforcer />
      <AuthProvider>
        <MarketDataProvider>
          <BrokerAuthProvider>
            <AdminAuthProvider>
              <div className="App font-['Inter']">
                <Routes>
                {/* Auth Routes */}
                <Route path="/" element={<LandingRoute />} />
                <Route path="/login" element={<GuestOnlyRoute><Login /></GuestOnlyRoute>} />
                <Route path="/signup" element={<GuestOnlyRoute><Signup /></GuestOnlyRoute>} />
                <Route path="/registration-status/:id" element={<RegistrationStatus />} />
                
                {/* Customer Routes with Bottom Navigation */}
                <Route element={<RequireCustomerAuth><CustomerLayout /></RequireCustomerAuth>}>
                  {/* Customer — Account Routes (accessible after login, before KYC) */}
                  <Route path="/profile" element={<Profile />} />

                  {/* Customer — Trading Routes (require KYC approval + trading_enabled) */}
                  <Route element={<RequireTradingEnabled><Outlet /></RequireTradingEnabled>}>
                    <Route path="/watchlist" element={<Watchlist />} />
                    <Route path="/orders" element={<Orders />} />
                    <Route path="/portfolio" element={<Portfolio />} />
                    <Route path="/funds" element={<Funds />} />
                  </Route>
                </Route>

                {/* Profile Edit — no bottom nav */}
                <Route path="/profile/edit" element={<RequireCustomerAuth><ProfileEdit /></RequireCustomerAuth>} />

                {/* KYC pending — shown when trading_enabled is false */}
                <Route path="/kyc-pending" element={<RequireCustomerAuth><KYCPending /></RequireCustomerAuth>} />

                {/* Customer Routes without Bottom Navigation */}
                <Route path="/portfolio/invoice" element={<RequireCustomerAuth><PortfolioInvoice /></RequireCustomerAuth>} />
                <Route path="/order-book" element={<RequireCustomerAuth><OrderBook /></RequireCustomerAuth>} />
                <Route path="/funds/add" element={<RequireCustomerAuth><AddFunds /></RequireCustomerAuth>} />
                <Route path="/funds/history" element={<RequireCustomerAuth><FundStatement /></RequireCustomerAuth>} />
                <Route path="/funds/add/confirm" element={<RequireCustomerAuth><AddFundsConfirm /></RequireCustomerAuth>} />
                <Route path="/funds/withdraw" element={<RequireCustomerAuth><WithdrawFunds /></RequireCustomerAuth>} />
                <Route path="/funds/withdraw/confirm" element={<RequireCustomerAuth><WithdrawalConfirm /></RequireCustomerAuth>} />
                <Route path="/profile/payments" element={<RequireCustomerAuth><Payments /></RequireCustomerAuth>} />
                <Route path="/settings" element={<RequireCustomerAuth><AccountSettings /></RequireCustomerAuth>} />
                <Route path="/profile/bank-account/add" element={<RequireCustomerAuth><AddBankAccount /></RequireCustomerAuth>} />
                <Route path="/profile/bank-account/edit/:id" element={<RequireCustomerAuth><AddBankAccount /></RequireCustomerAuth>} />
                <Route path="/account-summary" element={<RequireCustomerAuth><AccountSummary /></RequireCustomerAuth>} />
                <Route path="/support" element={<RequireCustomerAuth><Help /></RequireCustomerAuth>} />
                <Route path="/kyc" element={<RequireCustomerAuth><KycDetails /></RequireCustomerAuth>} />
                <Route path="/kyc-documents" element={<RequireCustomerAuth><KYCDocuments /></RequireCustomerAuth>} />
                <Route path="/order-confirmation" element={<RequireCustomerAuth><OrderConfirmation /></RequireCustomerAuth>} />
                <Route path="/option-chain" element={<RequireCustomerAuth><OptionChain /></RequireCustomerAuth>} />
                <Route path="/chart" element={<RequireCustomerAuth><ChartView /></RequireCustomerAuth>} />

                {/* Broker Routes with Bottom Navigation */}
                <Route element={<RequireBrokerAuth><BrokerLayout /></RequireBrokerAuth>}>
                  <Route path="/broker/dashboard" element={<BrokerDashboard />} />
                  <Route path="/broker/clients" element={<BrokerClientList />} />
                  <Route path="/broker/approvals" element={<BrokerApprovals />} />
                  <Route path="/broker/management" element={<BrokerManagement />} />
                  <Route path="/broker/funds" element={<BrokerFunds />} />
                  <Route path="/broker/settings" element={<BrokerSettings />} />
                </Route>

                {/* Broker Routes without Bottom Navigation */}
                <Route path="/broker/login" element={<GuestOnlyRoute><BrokerLogin /></GuestOnlyRoute>} />
                <Route path="/broker/clients/new" element={<RequireBrokerAuth><BrokerCreateClient /></RequireBrokerAuth>} />
                <Route path="/broker/clients/:clientId" element={<RequireBrokerAuth><BrokerClientDetail /></RequireBrokerAuth>} />
                <Route path="/broker/clients/:clientId/edit" element={<RequireBrokerAuth><BrokerEditClient /></RequireBrokerAuth>} />
                <Route path="/broker/recycle-bin" element={<RequireBrokerAuth><BrokerRecycleBin /></RequireBrokerAuth>} />
                <Route path="/broker/cnc-approvals" element={<RequireBrokerAuth><BrokerCncOrderApprovals /></RequireBrokerAuth>} />
                <Route path="/broker/withdrawals" element={<RequireBrokerAuth><BrokerWithdrawalRequests /></RequireBrokerAuth>} />
                <Route path="/broker/logs" element={<RequireBrokerAuth><BrokerLogs /></RequireBrokerAuth>} />
                <Route path="/broker/margin" element={<RequireBrokerAuth><Navigate to="/broker/logs" replace /></RequireBrokerAuth>} />
                <Route path="/broker/payment-verification" element={<RequireBrokerAuth><BrokerPaymentVerification /></RequireBrokerAuth>} />

                {/* Admin Routes */}
                <Route path="/admin/login" element={<GuestOnlyRoute><AdminLogin /></GuestOnlyRoute>} />
                <Route path="/admin/dashboard" element={<RequireAdminAuth><AdminDashboard /></RequireAdminAuth>} />
                <Route path="/admin/brokers" element={<RequireAdminAuth><AdminBrokers /></RequireAdminAuth>} />
                <Route path="/admin/brokers/:brokerId" element={<RequireAdminAuth><AdminBrokers /></RequireAdminAuth>} />
                <Route path="/admin/customers" element={<RequireAdminAuth><AdminCustomers /></RequireAdminAuth>} />
                <Route path="/admin/customers/:customerId" element={<RequireAdminAuth><AdminCustomers /></RequireAdminAuth>} />
                <Route path="/admin/kyc" element={<RequireAdminAuth><AdminKYC /></RequireAdminAuth>} />
                <Route path="/admin/logs" element={<RequireAdminAuth><AdminLogs /></RequireAdminAuth>} />
                <Route path="/admin/access-token" element={<RequireAdminAuth><AdminAccessToken /></RequireAdminAuth>} />
                <Route path="/admin/settings" element={<RequireAdminAuth><AdminSettings /></RequireAdminAuth>} />
                <Route path="/admin/reports" element={<RequireAdminAuth><AdminReports /></RequireAdminAuth>} />
                <Route path="/admin/withdrawals" element={<RequireAdminAuth><AdminWithdrawals /></RequireAdminAuth>} />
                <Route path="/admin/funds" element={<RequireAdminAuth><AdminFunds /></RequireAdminAuth>} />
                <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </div>
            </AdminAuthProvider>
          </BrokerAuthProvider>
        </MarketDataProvider>
      </AuthProvider>
    </Router>
  );
}

export default App;
