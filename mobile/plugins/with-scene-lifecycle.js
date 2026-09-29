// @ts-check
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

/**
 * Adopts UIKit's scene-based life cycle, which the iOS 27 SDK requires: an app
 * built with it and without a scene manifest is refused at launch with
 * "UIScene life cycle is required for apps built with this SDK".
 *
 * Expo SDK 57 ships the scene delegate (`ExpoAppSceneDelegate`), but its
 * prebuild template still starts React Native from the app delegate. SDK 58's
 * template does it properly, and we cannot move to 58 yet because
 * expo-share-intent supports up to 57. So this applies 58's shape to 57:
 *
 * - the app delegate conforms to `ExpoReactNativeFactoryProvider` and stops
 *   creating its own window, since the scene delegate now does both;
 * - Info.plist names Expo's scene delegate, by its Objective-C name, so no
 *   Swift file has to be added to the Xcode project.
 *
 * Delete this plugin when upgrading to an SDK whose template already does it.
 */
module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return c;
  });

  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== 'swift') {
      throw new Error('with-scene-lifecycle: expected a Swift AppDelegate');
    }
    let src = c.modResults.contents;

    if (!src.includes('ExpoReactNativeFactoryProvider')) {
      const declaration = /class AppDelegate: ExpoAppDelegate \{/;
      if (!declaration.test(src)) {
        throw new Error('with-scene-lifecycle: AppDelegate declaration not found; the template changed');
      }
      src = src.replace(declaration, 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    }

    // The window and startReactNative move to the scene delegate. Left here, the
    // app would start React Native twice, once into a window nothing shows.
    const startInWindow =
      /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\([\s\S]*?\)\s*#endif\s*/;
    if (startInWindow.test(src)) {
      src = src.replace(
        startInWindow,
        '// The window is created and React Native started by the scene delegate\n    // (with-scene-lifecycle plugin), as the iOS 27 SDK requires.\n    ',
      );
    } else if (src.includes('UIWindow(frame:')) {
      throw new Error('with-scene-lifecycle: could not remove the window setup; the template changed');
    }

    c.modResults.contents = src;
    return c;
  });

  return config;
};
