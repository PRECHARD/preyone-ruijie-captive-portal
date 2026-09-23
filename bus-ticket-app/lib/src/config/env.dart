/// Build/environment configuration for the Preyone Transit app.
///
/// The production API base URL is baked in so conductors and drivers never
/// have to configure a server URL at login. The backend runs on the VPS
/// (158.220.118.91) and is exposed to the internet as api.preyone.com.
const String kDefaultApiBaseUrl = 'https://api.preyone.com';