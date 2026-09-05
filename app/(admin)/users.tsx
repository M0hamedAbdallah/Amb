import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Alert, RefreshControl, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adminService } from '@/services/adminService';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { RoleBadge } from '@/components/ui/Badge';

const TABS = [
  { id: 'all', label: 'الكل' },
  { id: 'customer', label: 'عملاء' },
  { id: 'vendor', label: 'بائعون' },
];

export default function UsersScreen() {
  const insets = useSafeAreaInsets();
  const [users, setUsers] = useState<any[]>([]);
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { users: real } = await adminService.getAllUsers();
    // Honest about backend state — replace the list, don't keep stale rows.
    setUsers((real as any[]) || []);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = users.filter((u) =>
    (tab === 'all' || u.role === tab) &&
    (search ? u.name?.includes(search) || u.phone?.includes(search) : true)
  );

  const handleToggle = (userId: string, currentStatus: boolean) => {
    const action = currentStatus ? 'تعطيل' : 'تفعيل';
    Alert.alert(`${action} الحساب`, `هل تريد ${action} هذا الحساب؟`, [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: action,
        style: currentStatus ? 'destructive' : 'default',
        onPress: async () => {
          await adminService.toggleUserStatus(userId, !currentStatus);
          setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, is_active: !currentStatus } : u));
        },
      },
    ]);
  };

  const handleVerifyVendor = (userId: string) => {
    Alert.alert('توثيق البائع', 'هل تريد توثيق وتفعيل حساب البائع؟', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'توثيق',
        onPress: async () => {
          await adminService.verifyVendor(userId);
          setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, is_active: true } : u));
          Alert.alert('تم!', 'تم توثيق البائع وتفعيل حسابه');
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>إدارة المستخدمين</Text>
        <Text style={styles.count}>{filtered.length} مستخدم</Text>
      </View>

      <View style={styles.searchBox}>
        <MaterialIcons name="search" size={18} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="بحث بالاسم أو الهاتف..."
          placeholderTextColor={Colors.textDim}
          value={search}
          onChangeText={setSearch}
          textAlign="right"
        />
      </View>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id ? styles.tabActive : null]}>
            <Text style={[styles.tabText, tab === t.id ? styles.tabTextActive : null]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        renderItem={({ item }) => (
          <View style={styles.userCard}>
            <View style={styles.userAvatar}>
              <Text style={styles.avatarChar}>{item.name.charAt(0)}</Text>
            </View>
            <View style={styles.userInfo}>
              <View style={styles.userNameRow}>
                <Text style={styles.userName}>{item.name}</Text>
                <RoleBadge role={item.role} />
              </View>
              <Text style={styles.userPhone}>{item.phone}</Text>
              <Text style={styles.userDate}>
                انضم {new Date(item.created_at).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.userActions}>
              {item.role === 'vendor' && !item.is_active ? (
                <TouchableOpacity onPress={() => handleVerifyVendor(item.id)} style={styles.verifyBtn}>
                  <MaterialIcons name="verified" size={16} color={Colors.success} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                onPress={() => handleToggle(item.id, item.is_active)}
                style={[styles.toggleBtn, item.is_active ? styles.toggleActive : styles.toggleInactive]}
              >
                <MaterialIcons name={item.is_active ? 'check-circle' : 'block'} size={16} color={item.is_active ? Colors.success : Colors.error} />
              </TouchableOpacity>
            </View>
          </View>
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={'#8B5CF6'}
            colors={['#8B5CF6']}
            progressBackgroundColor={Colors.surface}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.xs }} />}
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={'#8B5CF6'} size="large" />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>لا يوجد مستخدمون</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  title: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  count: { color: Colors.textMuted, fontSize: FontSize.sm },
  searchBox: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border, marginHorizontal: Spacing.md, paddingHorizontal: Spacing.md, height: 44, gap: Spacing.sm, marginBottom: Spacing.sm },
  searchInput: { flex: 1, color: Colors.text, fontSize: FontSize.base },
  tabs: { flexDirection: 'row-reverse', paddingHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.sm },
  tab: { paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
  tabText: { color: Colors.textMuted, fontSize: FontSize.sm },
  tabTextActive: { color: Colors.white, fontWeight: FontWeight.semibold },
  list: { paddingHorizontal: Spacing.md, paddingBottom: 16 },
  userCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm, borderWidth: 1, borderColor: Colors.border },
  userAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#8B5CF620', alignItems: 'center', justifyContent: 'center' },
  avatarChar: { color: '#8B5CF6', fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  userInfo: { flex: 1, gap: 3 },
  userNameRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: Spacing.sm },
  userName: { color: Colors.text, fontSize: FontSize.base, fontWeight: FontWeight.semibold },
  userPhone: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'right' },
  userDate: { color: Colors.textDim, fontSize: FontSize.xs, textAlign: 'right' },
  userActions: { flexDirection: 'row-reverse', gap: Spacing.sm },
  verifyBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: `${Colors.success}18`, alignItems: 'center', justifyContent: 'center' },
  toggleBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  toggleActive: { backgroundColor: `${Colors.success}18` },
  toggleInactive: { backgroundColor: `${Colors.error}18` },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { color: Colors.textMuted, fontSize: FontSize.base },
});
