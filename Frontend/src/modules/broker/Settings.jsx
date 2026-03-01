import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import brokerApi from '../../api/broker';
import { useBrokerAuth } from '../../context/BrokerContext';

const Settings = () => {
  const navigate = useNavigate();
  const { logout } = useBrokerAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrUploading, setQrUploading] = useState(false);
  const [qrRemoving, setQrRemoving] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState('');
  const qrFileRef = useRef(null);

  const [broker, setBroker] = useState({
    name: '',
    brokerId: '',
    companyName: '',
    isVerified: false,
    referenceCode: '',
  });
  const [codeCopied, setCodeCopied] = useState(false);

  const [clientInfo, setClientInfo] = useState({
    supportContact: '',
    upiId: '',
    qrPhotoUrl: ''
  });

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const profileRes = await brokerApi.getProfile();

      const p = profileRes.profile || profileRes.broker || profileRes.data || profileRes;

      setBroker({
        name: p.ownerName || p.name || p.owner_name || '',
        brokerId: p.brokerId || p.broker_id || p.id || '',
        companyName: p.companyName || p.company_name || '',
        isVerified: p.kyc_verified || p.isVerified || false,
        referenceCode: p.reference_code || p.referenceCode || '',
      });

      setClientInfo({
        supportContact: p.support_contact || p.supportContact || p.phone || '',
        upiId: p.upi_id || p.upiId || '',
        qrPhotoUrl: p.payment_qr_url || p.paymentQrUrl || ''
      });
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSaveClientInfo = async (field, value) => {
    setSaving(true);
    try {
      const updated = { ...clientInfo, [field]: value };
      await brokerApi.updateClientInfo({
        supportContact: updated.supportContact,
        upiId: updated.upiId,
        qrPhotoUrl: updated.qrPhotoUrl
      });
      setClientInfo(updated);
      setEditingField(null);
    } catch (err) {
      console.error('Failed to save client info:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCopyCode = () => {
    if (!broker.referenceCode) return;
    navigator.clipboard.writeText(broker.referenceCode).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  };

  const handleLogout = () => {
    logout();
    navigate('/broker/login');
  };

  const uploadQrToCloudinary = async (file) => {
    const sigRes = await brokerApi.getClientInfoUploadSignature();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', sigRes.apiKey);
    formData.append('timestamp', sigRes.timestamp);
    formData.append('signature', sigRes.signature);
    formData.append('folder', sigRes.folder);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${sigRes.cloudName}/image/upload`,
      { method: 'POST', body: formData }
    );
    const data = await uploadRes.json();
    if (!data.secure_url) {
      throw new Error('QR upload failed');
    }
    return { url: data.secure_url, publicId: data.public_id };
  };

  const handleQrFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setQrUploading(true);
    try {
      const uploaded = await uploadQrToCloudinary(file);
      await brokerApi.updateClientInfo({
        qrPhotoUrl: uploaded.url,
        qrPhotoPublicId: uploaded.publicId,
      });
      setClientInfo((prev) => ({ ...prev, qrPhotoUrl: uploaded.url }));
    } catch (err) {
      console.error('Failed to upload QR photo:', err);
    } finally {
      setQrUploading(false);
    }
  };

  const handleRemoveQr = async () => {
    if (!clientInfo.qrPhotoUrl) return;
    setQrRemoving(true);
    try {
      await brokerApi.updateClientInfo({
        qrPhotoUrl: '',
        qrPhotoPublicId: '',
      });
      setClientInfo((prev) => ({ ...prev, qrPhotoUrl: '' }));
    } catch (err) {
      console.error('Failed to remove QR photo:', err);
    } finally {
      setQrRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-[#f6f7f8] pb-20">
        <div className="sticky top-0 z-50 bg-white border-b border-gray-200">
          <div className="flex items-center px-3 sm:px-4 py-2.5 sm:py-3">
            <h1 className="text-lg sm:text-xl font-bold">Settings</h1>
          </div>
        </div>
        <div className="flex-1 p-4 space-y-4">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-xl p-4 animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-32 mb-3"></div>
              <div className="h-4 bg-gray-200 rounded w-48"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#f6f7f8] pb-20">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-white border-b border-gray-200">
        <div className="flex items-center px-3 sm:px-4 py-2.5 sm:py-3">
          <h1 className="text-lg sm:text-xl font-bold leading-tight">Settings</h1>
        </div>
      </div>

      <div className="flex-1 flex flex-col p-3 sm:p-4 gap-5 overflow-y-auto">
        {/* Profile Card */}
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="flex p-3 sm:p-4 items-center gap-3">
            <div className="bg-[#137fec] rounded-full h-14 w-14 shrink-0 flex items-center justify-center">
              <span className="text-white text-lg font-bold">
                {broker.name ? broker.name.split(' ').map(n => n[0]).join('').toUpperCase() : '?'}
              </span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-base font-bold">{broker.name || 'Broker'}</p>
                {broker.isVerified && <span className="material-symbols-outlined text-[#137fec] text-[14px]">verified</span>}
              </div>
              {broker.companyName && <p className="text-[#617589] text-xs">{broker.companyName}</p>}
              <p className="text-[#617589] text-xs">ID: {broker.brokerId}</p>
            </div>
          </div>
        </div>

        {/* Registration Reference Code */}
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[#617589] text-[10px] font-semibold uppercase tracking-wider pl-2">Registration</h3>
          <div className="bg-white rounded-xl shadow-sm p-3 sm:p-4">
            <p className="text-sm font-semibold mb-0.5">Broker Reference Code</p>
            <p className="text-[#617589] text-xs mb-3">
              Share this code with prospective clients so their registration reaches your panel automatically.
            </p>
            {broker.referenceCode ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-[#f6f7f8] rounded-lg px-4 py-2.5 flex items-center">
                  <span className="font-mono text-lg font-bold tracking-widest text-[#111418]">
                    {broker.referenceCode}
                  </span>
                </div>
                <button
                  onClick={handleCopyCode}
                  className="h-10 px-3 bg-[#137fec] text-white rounded-lg text-xs font-bold flex items-center gap-1 hover:bg-[#137fec]/90 transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {codeCopied ? 'check' : 'content_copy'}
                  </span>
                  {codeCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : (
              <p className="text-xs text-[#617589] italic">Code not assigned yet. Contact admin.</p>
            )}
          </div>
        </div>

        {/* Client Facing Info */}
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[#617589] text-[10px] font-semibold uppercase tracking-wider pl-2">Client Facing Info</h3>
          <div className="bg-white rounded-xl shadow-sm overflow-hidden divide-y divide-gray-100">
            {/* Support Contact */}
            <div className="px-3 py-3 flex items-center justify-between">
              {editingField === 'supportContact' ? (
                <div className="flex-1 flex items-center gap-2">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="flex-1 h-9 px-3 rounded-lg bg-[#f6f7f8] text-sm outline-none border border-[#137fec]"
                    placeholder="Support contact number"
                  />
                  <button
                    onClick={() => handleSaveClientInfo('supportContact', editValue)}
                    disabled={saving}
                    className="h-9 px-3 bg-[#137fec] text-white text-xs font-bold rounded-lg"
                  >
                    {saving ? '...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingField(null)} className="h-9 px-2 text-[#617589]">
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-sm font-medium">Broker Contact Number</p>
                    <p className="text-[#617589] text-xs">{clientInfo.supportContact || 'Not set'}</p>
                  </div>
                  <button onClick={() => { setEditingField('supportContact'); setEditValue(clientInfo.supportContact); }} className="text-[#137fec] opacity-60 hover:opacity-100">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                </>
              )}
            </div>

            {/* UPI ID */}
            <div className="px-3 py-3 flex items-center justify-between">
              {editingField === 'upiId' ? (
                <div className="flex-1 flex items-center gap-2">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="flex-1 h-9 px-3 rounded-lg bg-[#f6f7f8] text-sm outline-none border border-[#137fec]"
                    placeholder="example@upi"
                  />
                  <button
                    onClick={() => handleSaveClientInfo('upiId', editValue)}
                    disabled={saving}
                    className="h-9 px-3 bg-[#137fec] text-white text-xs font-bold rounded-lg"
                  >
                    {saving ? '...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingField(null)} className="h-9 px-2 text-[#617589]">
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-sm font-medium">Fund Transfer UPI ID</p>
                    <p className="text-[#617589] text-xs">{clientInfo.upiId || 'Not set'}</p>
                  </div>
                  <button onClick={() => { setEditingField('upiId'); setEditValue(clientInfo.upiId); }} className="text-[#137fec] opacity-60 hover:opacity-100">
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                </>
              )}
            </div>

            {/* QR Photo */}
            <div className="px-3 py-3 flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Fund Transfer QR Photo</p>
                <p className="text-[#617589] text-xs">
                  {clientInfo.qrPhotoUrl ? 'QR photo set' : 'Not set'}
                </p>
                {clientInfo.qrPhotoUrl && (
                  <div className="mt-2 w-16 h-16 rounded-lg overflow-hidden border border-gray-200">
                    <img src={clientInfo.qrPhotoUrl} alt="Broker QR" className="w-full h-full object-cover" />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={qrFileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleQrFileChange}
                />
                <button
                  onClick={() => qrFileRef.current?.click()}
                  disabled={qrUploading || qrRemoving}
                  className="h-9 px-3 bg-[#137fec] text-white text-xs font-bold rounded-lg disabled:opacity-60"
                >
                  {qrUploading ? 'Uploading...' : 'Set QR Photo'}
                </button>
                {clientInfo.qrPhotoUrl && (
                  <button
                    onClick={handleRemoveQr}
                    disabled={qrUploading || qrRemoving}
                    className="h-9 px-3 bg-red-50 border border-red-100 text-red-600 text-xs font-bold rounded-lg disabled:opacity-60"
                  >
                    {qrRemoving ? 'Removing...' : 'Remove QR'}
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-[#617589] px-2">
            Information entered here will be visible to your clients for fund transfers.
          </p>
        </div>

        {/* Logout */}
        <div className="mt-3 flex flex-col items-center gap-3">
          <button
            onClick={handleLogout}
            className="w-full bg-white text-red-500 font-semibold py-3 rounded-xl shadow-sm active:scale-[0.99] transition-transform flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
            Logout
          </button>
          <p className="text-[10px] text-[#617589]">OneCapital Broker v2.4.1</p>
        </div>
      </div>
    </div>
  );
};

export default Settings;
