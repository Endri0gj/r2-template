# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Photo Vault (Cloudflare R2 + D1 backend)

A **Photo Vault** feature: create an account, sign in, pick a photo, upload it
to Cloudflare R2, browse your gallery, delete it. Image bytes live in R2,
users/sessions/metadata in D1, and a Cloudflare Worker in [`server/`](./server)
decides who may read what — on every request, including each image.

```bash
# one-time setup
cp .env.example .env.local
cd server && npm install && cp .dev.vars.example .dev.vars

# generate your own token-signing key and put it in server/.dev.vars
openssl rand -base64 48

cd .. && npm run server:migrate

# run it
npm run server      # the Worker on 127.0.0.1:8787 (use server:lan for a phone)
npm start           # Metro, in another terminal
```

Then open the Vault tab and create an account. Locally, sign-up is open; a
deployed Worker defaults to invite-only.

The Vault tab needs `expo-image-picker` and `expo-secure-store`, both native
modules, so it requires a
[development build](https://docs.expo.dev/develop/development-builds/introduction/)
(`npx expo run:ios`) rather than Expo Go.

### Verify

```bash
npm test                 # 164 tests: 104 in the Worker, 60 in the app
npm run typecheck        # the Expo app
npm run server:typecheck # the Worker (src and test configs)
npx eslint .
```

> ⚠️ **Deploying requires the Workers Paid plan.** The auth endpoints hash
> passwords with PBKDF2 at 600,000 iterations, which does not fit the free
> plan's 10 ms CPU budget. Everything local works on any plan.

📖 **[docs/CLOUDFLARE_R2_EXPO_GUIDE.md](./docs/CLOUDFLARE_R2_EXPO_GUIDE.md)** is a
complete standalone tutorial covering the architecture, local development,
authentication, testing, security, deployment, and how to research Cloudflare's
docs yourself.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **example** directory and create a blank **src/app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
