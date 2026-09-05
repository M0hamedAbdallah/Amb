import React, { useState } from 'react';
import {
  View, TextInput, Text, StyleSheet, TouchableOpacity,
  ViewStyle, TextInputProps,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Spacing, Shadow } from '@/constants/theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  leftIcon?: keyof typeof MaterialIcons.glyphMap;
  rightIcon?: keyof typeof MaterialIcons.glyphMap;
  onRightIconPress?: () => void;
  containerStyle?: ViewStyle;
  isPassword?: boolean;
}

export function Input({
  label, error, leftIcon, rightIcon, onRightIconPress,
  containerStyle, isPassword, style, ...props
}: InputProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <View style={[styles.container, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {/* row-reverse: leading icon renders on the right where RTL text starts */}
      <View style={[styles.inputWrapper, error ? styles.inputError : null]}>
        {leftIcon ? (
          <MaterialIcons name={leftIcon} size={20} color={Colors.textMuted} style={styles.leadIcon} />
        ) : null}
        <TextInput
          style={[styles.input, leftIcon ? styles.inputWithLead : null, style]}
          placeholderTextColor={Colors.textDim}
          secureTextEntry={isPassword && !showPassword}
          textAlign="right"
          {...props}
        />
        {isPassword ? (
          <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.tailIcon}>
            <MaterialIcons
              name={showPassword ? 'visibility' : 'visibility-off'}
              size={20}
              color={Colors.textMuted}
            />
          </TouchableOpacity>
        ) : rightIcon ? (
          <TouchableOpacity onPress={onRightIconPress} style={styles.tailIcon} disabled={!onRightIconPress}>
            <MaterialIcons name={rightIcon} size={20} color={Colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  label: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500', textAlign: 'right' },
  inputWrapper: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadow.sm,
  },
  inputError: { borderColor: Colors.error },
  input: {
    flex: 1,
    height: 52,
    color: Colors.text,
    fontSize: FontSize.base,
    paddingHorizontal: Spacing.md,
    writingDirection: 'rtl',
  },
  inputWithLead: { paddingLeft: Spacing.xs },
  leadIcon: { paddingRight: Spacing.md },
  tailIcon: { paddingLeft: Spacing.md },
  error: { color: Colors.error, fontSize: FontSize.xs, textAlign: 'right' },
});
