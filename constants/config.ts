// Ambobtak Platform Configuration
export const AppConfig = {
    name: 'أمبوبتك',
    nameEn: 'Ambobtak',
    currency: 'جنيه',
    currencyCode: 'EGP',
  
    // Commission
    platformCommissionPct: 10, // 10% default
    urgentOrderFee: 15, // EGP
    cancellationFee: 10, // EGP
  
    // Dispatch
    vendorResponseTimeoutMinutes: 3,
    maxDispatchRetries: 5,
    defaultDeliveryRadiusKm: 5,
  
    // Cylinder Sizes
    cylinderSizes: [
      { id: 'small', label: 'صغيرة', labelEn: 'Small', defaultPrice: 30, weight: '12.5 كجم' },
      { id: 'large', label: 'كبيرة', labelEn: 'Large', defaultPrice: 65, weight: '50 كجم' },
    ],
  
    // Egyptian payment methods
    paymentMethods: [
      { id: 'vodafone_cash', label: 'فودافون كاش', icon: '📱' },
      { id: 'etisalat_cash', label: 'اتصالات كاش', icon: '📱' },
      { id: 'orange_money', label: 'اورنچ موني', icon: '📱' },
      { id: 'instapay', label: 'إنستاباي', icon: '💳' },
      { id: 'cash', label: 'كاش عند الاستلام', icon: '💵' },
    ],
  
    // Order statuses
    orderStatuses: {
      awaiting_payment: { label: 'بانتظار تأكيد الدفع', color: '#6366F1' },
      pending: { label: 'بانتظار قبول البائع', color: '#F59E0B' },
      accepted: { label: 'تم القبول', color: '#3B82F6' },
      on_way: { label: 'البائع في الطريق', color: '#8B5CF6' },
      delivered: { label: 'تم التسليم', color: '#22C55E' },
      cancelled: { label: 'ملغي', color: '#EF4444' },
    },
  
    // Referral
    referralDiscount: 10, // EGP per successful referral
    
    // Premium vendor subscription
    premiumMonthlyFee: 199, // EGP/month
  };
  