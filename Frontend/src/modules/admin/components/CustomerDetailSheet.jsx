import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import adminApi from '../../../api/admin';
import { setAuthToken, setStoredUser } from '../../../api/index';

const CustomerDetailSheet = ({ customerId, onClose }) => {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [showCredentials, setShowCredentials] = useState(false);
  const [credLoading, setCredLoading] = useState(false);

  const fetchCustomer = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getCustomerById(customerId);
      setCustomer(res.customer || res);
    } catch (err) {
      setError(err.message || 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    if (customerId) fetchCustomer();
  }, [fetchCustomer]);

  const handleBlock = async () => {
    setActionLoading(true);
    try {
      const isBlocked = customer.status === 'blocked';
      if (isBlocked) {
        await adminApi.unblockCustomer(customer._id);
        setCustomer(prev => ({ ...prev, status: 'active' }));
      } else {
        await adminApi.blockCustomer(customer._id, 'Blocked by admin');
        setCustomer(prev => ({ ...prev, status: 'blocked', tradingEnabled: false }));
      }
    } catch (err) {
      setError(err.message || 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleTrading = async () => {
    setActionLoading(true);
    try {
      const newEnabled = !customer.tradingEnabled;
      if (newEnabled) {
        await adminApi.enableTrading(customer._id);
      } else {
        await adminApi.disableTrading(customer._id);
      }
      setCustomer(prev => ({ ...prev, tradingEnabled: newEnabled }));
    } catch (err) {
      setError(err.message || 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleHoldingsExit = async () => {
    setActionLoading(true);
    try {
      const newAllowed = !customer.holdingsExitAllowed;
      await adminApi.toggleHoldingsExit(customer._id, newAllowed);
      setCustomer(prev => ({ ...prev, holdingsExitAllowed: newAllowed }));
    } catch (err) {
      setError(err.message || 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleLoginAs = async () => {
    setActionLoading(true);
    try {
      const res = await adminApi.loginAsCustomer(customer._id);
      if (res.token) {
        setAuthToken(res.token);
        setStoredUser({ id: res.customer.id, name: res.customer.name, role: 'customer', isImpersonation: true });
        navigate('/watchlist');
      }
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleViewCredentials = async () => {
    if (credentials) { setShowCredentials(v => !v); return; }
    setCredLoading(true);
    try {
      const res = await adminApi.getCustomerCredentials(customer._id);
      setCredentials(res.credentials);
      setShowCredentials(true);
    } catch (err) {
      setError(err.message || 'Failed to fetch credentials');
    } finally {
      setCredLoading(false);
    }
  };

  const statusColor = (s) => {
    if (s === 'blocked') return 'bg-red-100 text-red-700';
    if (s === 'active') return 'bg-green-100 text-green-700';
    return 'bg-gray-100 text-gray-600';
  };

  const kycColor = (s) => {
    if (s === 'verified') return 'bg-green-100 text-green-700';
    if (s === 'rejected') return 'bg-red-100 text-red-700';
    if (s === 'under_review') return 'bg-blue-100 text-blue-700';
    return 'bg-yellow-100 text-yellow-700';
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: 'rgba(0,0,0,0.45)' }}>
      <div className="flex-1" onClick={onClose} />
      <div className="bg-white rounded-t-2xl max-h-[92dvh] flex flex-col w-full max-w-md mx-auto overflow-hidden">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 shrink-0 border-b border-gray-100">
          <h2 className="text-base font-bold">Customer Detail</h2>
          <button onClick={onClose} className="flex items-center justify-center size-8 rounded-full hover:bg-gray-100">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-4 py-4 flex flex-col gap-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-[#137fec] animate-spin" />
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-sm text-red-700">{error}</div>
          )}

          {!loading && customer && (
            <>
              {/* Identity */}
              <div className="bg-gray-50 rounded-xl p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="size-12 rounded-full bg-gradient-to-br from-[#137fec] to-purple-500 flex items-center justify-center text-white font-bold text-lg shrink-0">
                    {customer.name?.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-sm truncate">{customer.name}</h3>
                    <p className="text-xs text-gray-500 truncate">{customer.email}</p>
                    <p className="text-xs text-gray-500">{customer.phone}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColor(customer.status)}`}>
                      {customer.status}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${kycColor(customer.kycStatus)}`}>
                      KYC: {customer.kycStatus}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-white rounded-lg px-2.5 py-2">
                    <p className="text-gray-400 uppercase tracking-wide mb-0.5">Customer ID</p>
                    <p className="font-semibold font-mono">{customer.id}</p>
                  </div>
                  <div className="bg-white rounded-lg px-2.5 py-2">
                    <p className="text-gray-400 uppercase tracking-wide mb-0.5">Broker</p>
                    <p className="font-semibold truncate">{customer.broker?.name || customer.broker?.id || '—'}</p>
                  </div>
                  {customer.panNumber && (
                    <div className="bg-white rounded-lg px-2.5 py-2">
                      <p className="text-gray-400 uppercase tracking-wide mb-0.5">PAN</p>
                      <p className="font-semibold font-mono">{customer.panNumber}</p>
                    </div>
                  )}
                  <div className="bg-white rounded-lg px-2.5 py-2">
                    <p className="text-gray-400 uppercase tracking-wide mb-0.5">Last Login</p>
                    <p className="font-semibold">{customer.lastLogin ? new Date(customer.lastLogin).toLocaleDateString('en-IN') : 'Never'}</p>
                  </div>
                </div>
              </div>

              {/* Funds Snapshot */}
              {customer.funds && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Funds</p>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-white rounded-lg px-2 py-2 text-center">
                      <p className="text-gray-400 mb-0.5">Balance</p>
                      <p className="font-bold">₹{(customer.funds.balance || 0).toFixed(0)}</p>
                    </div>
                    <div className="bg-white rounded-lg px-2 py-2 text-center">
                      <p className="text-gray-400 mb-0.5">Intraday</p>
                      <p className="font-bold">₹{(customer.funds.intradayLimit || 0).toFixed(0)}</p>
                    </div>
                    <div className="bg-white rounded-lg px-2 py-2 text-center">
                      <p className="text-gray-400 mb-0.5">Orders</p>
                      <p className="font-bold">{customer.stats?.totalOrders || 0}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Controls */}
              <div className="bg-gray-50 rounded-xl p-4 flex flex-col gap-3">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">Controls</p>

                {/* Block / Unblock */}
                <div className={`flex items-center justify-between bg-white p-3 rounded-xl ${actionLoading ? 'opacity-60 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <div className={`p-2 rounded-full ${customer.status === 'blocked' ? 'bg-orange-50 text-orange-500' : 'bg-red-50 text-red-500'}`}>
                      <span className="material-symbols-outlined text-[18px]">{customer.status === 'blocked' ? 'lock_open' : 'block'}</span>
                    </div>
                    <div>
                      <p className="text-xs font-bold">{customer.status === 'blocked' ? 'Unblock Account' : 'Block Account'}</p>
                      <p className="text-[10px] text-gray-500">{customer.status === 'blocked' ? 'Re-enable access' : 'Suspend all access'}</p>
                    </div>
                  </div>
                  <button
                    onClick={handleBlock}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${customer.status === 'blocked' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                  >
                    {customer.status === 'blocked' ? 'Unblock' : 'Block'}
                  </button>
                </div>

                {/* Trading toggle */}
                <div className={`flex items-center justify-between bg-white p-3 rounded-xl ${actionLoading || customer.status === 'blocked' ? 'opacity-60 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-full bg-red-50 text-red-500">
                      <span className="material-symbols-outlined text-[18px]">do_not_disturb</span>
                    </div>
                    <div>
                      <p className="text-xs font-bold">Stop Trading</p>
                      <p className="text-[10px] text-gray-500">Disable order placement</p>
                    </div>
                  </div>
                  <div className="relative inline-block w-10 h-5 select-none">
                    <input type="checkbox" checked={!customer.tradingEnabled} onChange={handleToggleTrading}
                      disabled={actionLoading || customer.status === 'blocked'}
                      className="sr-only peer" id="adminTradingToggle" />
                    <label htmlFor="adminTradingToggle"
                      className={`block overflow-hidden h-5 rounded-full cursor-pointer transition-colors ${!customer.tradingEnabled ? 'bg-red-500' : 'bg-gray-300'}`}>
                      <span className={`block w-4 h-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${!customer.tradingEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}></span>
                    </label>
                  </div>
                </div>

                {/* Holdings Exit toggle */}
                <div className={`flex items-center justify-between bg-white p-3 rounded-xl ${actionLoading || customer.status === 'blocked' ? 'opacity-60 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <div className={`p-2 rounded-full ${customer.holdingsExitAllowed ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                      <span className="material-symbols-outlined text-[18px]">{customer.holdingsExitAllowed ? 'lock_open' : 'lock'}</span>
                    </div>
                    <div>
                      <p className="text-xs font-bold">Holdings Exit</p>
                      <p className="text-[10px] text-gray-500">{customer.holdingsExitAllowed ? 'Customer can exit holdings' : 'Exit locked'}</p>
                    </div>
                  </div>
                  <div className="relative inline-block w-10 h-5 select-none">
                    <input type="checkbox" checked={!!customer.holdingsExitAllowed} onChange={handleToggleHoldingsExit}
                      disabled={actionLoading || customer.status === 'blocked'}
                      className="sr-only peer" id="adminHoldingsExitToggle" />
                    <label htmlFor="adminHoldingsExitToggle"
                      className={`block overflow-hidden h-5 rounded-full cursor-pointer transition-colors ${customer.holdingsExitAllowed ? 'bg-emerald-500' : 'bg-gray-300'}`}>
                      <span className={`block w-4 h-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${customer.holdingsExitAllowed ? 'translate-x-5' : 'translate-x-0.5'}`}></span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Credentials */}
              <div className="bg-gray-50 rounded-xl p-4">
                <button
                  onClick={handleViewCredentials}
                  disabled={credLoading}
                  className="w-full flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-full bg-blue-50 text-[#137fec]">
                      <span className="material-symbols-outlined text-[18px]">key</span>
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-bold">View Credentials</p>
                      <p className="text-[10px] text-gray-500">Customer ID + password</p>
                    </div>
                  </div>
                  {credLoading
                    ? <div className="h-4 w-4 rounded-full border-2 border-gray-200 border-t-[#137fec] animate-spin" />
                    : <span className="material-symbols-outlined text-gray-400 text-[18px]">{showCredentials ? 'expand_less' : 'expand_more'}</span>
                  }
                </button>
                {showCredentials && credentials && (
                  <div className="mt-3 grid grid-cols-1 gap-2 text-[11px]">
                    <div className="bg-white rounded-lg px-3 py-2 flex justify-between">
                      <span className="text-gray-400">Customer ID</span>
                      <span className="font-semibold font-mono">{credentials.customerId}</span>
                    </div>
                    <div className="bg-white rounded-lg px-3 py-2 flex justify-between">
                      <span className="text-gray-400">Email</span>
                      <span className="font-semibold">{credentials.email || '—'}</span>
                    </div>
                    <div className="bg-white rounded-lg px-3 py-2 flex justify-between">
                      <span className="text-gray-400">Password</span>
                      <span className="font-semibold font-mono">{credentials.password}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Login As */}
              <button
                onClick={handleLoginAs}
                disabled={actionLoading}
                className="w-full flex items-center justify-center gap-2 h-11 bg-[#137fec] text-white rounded-xl text-sm font-semibold shadow-sm hover:bg-blue-600 transition-colors disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">login</span>
                Login As Customer
              </button>

              <div className="pb-4" />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CustomerDetailSheet;
