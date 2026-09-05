import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, Alert,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Colors, FontSize, FontWeight, Radius, Spacing, Shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { referralService } from '@/services/referralService';

const MENU_ITEMS = [
  { icon: 'place', label: 'عناويني المحفوظة', route: null },
  { icon: 'local-offer', label: 'كوباياتي', route: null },
  { icon: 'group-add', label: 'دعوة صديق — اكسب 10 جنيه', route: null, highlight: true },
  { icon: 'flag', label: 'شكاواي', route: '/(customer)/complaints' },
  { icon: 'notifications', label: 'الإشعارات', route: null },
  { icon: 'help', label: 'المساعدة والدعم', route: '/(customer)/complaints' },
  { icon: 'description', label: 'الشروط والأحكام', route: null },
  { icon: 'info', label: 'عن أمبوبتك', route: null },
];

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const [refStats, setRefStats] = useState<{ referees: number; qualified: number; earned: number }>(
    { referees: 0, qualified: 0, earned: 0 }
  );

  useEffect(() => {
    if (!profile?.id) return;
    referralService.getMyStats(profile.id).then(setRefStats).catch(() => {});
  }, [profile?.id]);

  const handleReferral = async () => {
    try {
      await Share.share({
        message: `استخدم كودي ${profile?.referral_code || 'AMBO10'} في تطبيق أمبوبتك واحصل على خصم 10 جنيه على أول طلب! حمّل التطبيق الآن 🔥`,
      });
    } catch {}
  };

  const comingSoon = () => Alert.alert('قريبًا', 'هذه الميزة قيد التجهيز حاليًا');

  const handleMenuPress = (item: typeof MENU_ITEMS[number]) => {
    if (item.label.includes('دعوة')) return handleReferral();
    if (item.route) router.push(item.route as Href);
    else comingSoon();
  };

  const handleSignOut = () => {
    Alert.alert('تسجيل الخروج', 'هل تريد تسجيل الخروج؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 80 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Profile Header */}
      <View style={styles.profileHeader}>
        <View style={styles.avatarBox}>
          <Text style={styles.avatarText}>
            {profile?.name?.charAt(0) || '?'}
          </Text>
        </View>
        <Text style={styles.name}>{profile?.name || 'مستخدم'}</Text>
        <Text style={styles.phone}>{profile?.phone || ''}</Text>
        <TouchableOpacity style={styles.editBtn} onPress={comingSoon}>
          <MaterialIcons name="edit" size={14} color={Colors.primary} />
          <Text style={styles.editText}>تعديل الملف الشخصي</Text>
        </TouchableOpacity>
      </View>

      {/* Wallet Card */}
      <View style={styles.walletCard}>
        <View>
          <Text style={styles.walletLabel}>رصيد المحفظة</Text>
          <Text style={styles.walletBalance}>{profile?.wallet_balance || 0} جنيه</Text>
        </View>
        <View style={styles.walletActions}>
          <TouchableOpacity style={styles.walletBtn} onPress={comingSoon}>
            <MaterialIcons name="add" size={18} color={Colors.primary} />
            <Text style={styles.walletBtnText}>شحن</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.walletBtn} onPress={() => router.push('/(customer)/history' as Href)}>
            <MaterialIcons name="history" size={18} color={Colors.textMuted} />
            <Text style={styles.walletBtnText}>السجل</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Referral Code + stats */}
      <TouchableOpacity onPress={handleReferral} style={styles.referralCard} activeOpacity={0.85}>
        <View style={styles.referralInfo}>
          <Text style={styles.referralTitle}>كودك الخاص 🎁</Text>
          <Text style={styles.referralCode}>{profile?.referral_code || 'AMBO10'}</Text>
          <Text style={styles.referralSub}>شارك الكود واكسب 10 جنيه لكل صديق</Text>
        </View>
        <MaterialIcons name="share" size={28} color={Colors.white} />
      </TouchableOpacity>

      {/* Referral stats — referees count + credits earned */}
      <View style={styles.refStatsRow}>
        <View style={styles.refStat}>
          <Text style={styles.refStatValue}>{refStats.referees}</Text>
          <Text style={styles.refStatLabel}>صديق دُعي</Text>
        </View>
        <View style={styles.refStatDivider} />
        <View style={styles.refStat}>
          <Text style={styles.refStatValue}>{refStats.qualified}</Text>
          <Text style={styles.refStatLabel}>طلب مكتمل</Text>
        </View>
        <View style={styles.refStatDivider} />
        <View style={styles.refStat}>
          <Text style={[styles.refStatValue, { color: Colors.success }]}>{refStats.earned}</Text>
          <Text style={styles.refStatLabel}>جنيه مكتسب</Text>
        </View>
      </View>

      {/* Menu */}
      <View style={styles.menu}>
        {MENU_ITEMS.map((item, i) => (
          <TouchableOpacity
            key={i}
            activeOpacity={0.7}
            style={[styles.menuItem, (item as any).highlight ? styles.menuHighlight : null]}
            onPress={() => handleMenuPress(item)}
          >
            <View style={styles.menuRight}>
              <MaterialIcons
                name={item.icon as any}
                size={20}
                color={(item as any).highlight ? Colors.accent : Colors.textMuted}
              />
              <Text style={[styles.menuLabel, (item as any).highlight ? styles.menuLabelHighlight : null]}>
                {item.label}
              </Text>
            </View>
            <MaterialIcons name="arrow-back-ios" size={14} color={Colors.textDim} />
          </TouchableOpacity>
        ))}
      </View>

      {/* Sign Out */}
      <Button
        title="تسجيل الخروج"
        onPress={handleSignOut}
        variant="outline"
        style={styles.signOutBtn}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: Spacing.md, gap: Spacing.md },
  profileHeader: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md },
  avatarBox: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Shadow.lg,
  },
  avatarText: { color: Colors.white, fontSize: FontSize.xxxl, fontWeight: FontWeight.bold },
  name: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  phone: { color: Colors.textMuted, fontSize: FontSize.base },
  editBtn: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  editText: { color: Colors.primary, fontSize: FontSize.sm },
  walletCard: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  walletLabel: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  walletBalance: { color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  walletActions: { flexDirection: 'row-reverse', gap: Spacing.lg },
  walletBtn: { alignItems: 'center', gap: 4 },
  walletBtnText: { color: Colors.textMuted, fontSize: FontSize.xs },
  referralCard: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...Shadow.lg,
  },
  referralInfo: { flex: 1, gap: 2 },
  referralTitle: { color: 'rgba(255,255,255,0.85)', fontSize: FontSize.sm, textAlign: 'right' },
  referralCode: { color: Colors.white, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy, letterSpacing: 3 },
  referralSub: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.xs, textAlign: 'right', marginTop: 2 },
  refStatsRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  refStat: { flex: 1, alignItems: 'center', gap: 4 },
  refStatValue: { color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.heavy },
  refStatLabel: { color: Colors.textMuted, fontSize: FontSize.xs, textAlign: 'center' },
  refStatDivider: { width: 1, alignSelf: 'stretch', backgroundColor: Colors.border },
  menu: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  menuHighlight: { backgroundColor: `${Colors.accent}10` },
  menuRight: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.md },
  menuLabel: { color: Colors.text, fontSize: FontSize.base },
  menuLabelHighlight: { color: Colors.accent, fontWeight: FontWeight.semibold },
  signOutBtn: { marginTop: Spacing.sm },
});
