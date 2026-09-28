## Getting Started

### 1. Install Dependencies

```bash
npm install
# or
yarn install
```

### 2. Start the Project

- Start the development server (choose your platform):

```bash
npm run start         # Start Expo development server
npm run android       # Launch Android emulator
eas build --platform android --profile preview --local
./gradlew assembleRelease
npm run ios           # Launch iOS simulator
npm run web           # Start the web version
```

- Reset the project (clear cache, etc.):

```bash
npm run reset-project
```

### 3. Lint the Code

```bash
npm run lint
```

## Main Dependencies

- React Native: 0.79.4
- React: 19.0.0
- Expo: ~53.0.12
- Expo Router: ~5.1.0
- Supabase: ^2.50.0
- Other commonly used libraries:  
  - @expo/vector-icons  
  - react-native-paper  
  - react-native-calendars  
  - lottie-react-native  
  - react-native-webview  
  - and more

For a full list of dependencies, see [package.json](./package.json).

## Development Tools

- TypeScript: ~5.8.3
- ESLint: ^9.25.0
- @babel/core: ^7.25.2

## Contributing

1. Fork this repository
2. Create a new branch (`git checkout -b main`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

## License

This project is private ("private": true). For collaboration inquiries, please contact the author.

---

Feel free to add project screenshots, API documentation, feature descriptions, or any other information as needed.
