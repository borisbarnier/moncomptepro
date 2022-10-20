import { isEmpty, isString } from 'lodash';
import { isEmailSafeToSendTransactional } from '../connectors/debounce';
import { sendMail } from '../connectors/sendinblue';

import {
  create,
  findByEmail,
  findByMagicLinkToken,
  findByResetPasswordToken,
  findByVerifyEmailToken,
  update,
} from '../repositories/user';
import {
  generatePinToken,
  generateToken,
  hashPassword,
  isEmailValid,
  isPasswordSecure,
  isPhoneNumberValid,
  validatePassword,
} from '../services/security';

const { API_AUTH_HOST } = process.env;

const RESET_PASSWORD_TOKEN_EXPIRATION_DURATION_IN_MINUTES = 60;
const VERIFY_EMAIL_TOKEN_EXPIRATION_DURATION_IN_MINUTES = 60;
const MAGIC_LINK_TOKEN_EXPIRATION_DURATION_IN_MINUTES = 10;

const isExpired = (emittedDate, expirationDurationInMinutes) => {
  if (!(emittedDate instanceof Date)) {
    return true;
  }

  const nowDate = new Date();

  return nowDate - emittedDate > expirationDurationInMinutes * 60e3;
};

export const startLogin = async email => {
  const userExists = !isEmpty(await findByEmail(email));

  if (!userExists && !(await isEmailSafeToSendTransactional(email))) {
    throw new Error('invalid_email');
  }

  return { email, userExists };
};

export const login = async (email, password) => {
  const user = await findByEmail(email);
  if (isEmpty(user)) {
    // this is not a proper error name but this case should never happen
    // we throw a clean error as a mesure of defensive programming
    throw new Error('invalid_credentials');
  }

  const isMatch = await validatePassword(password, user.encrypted_password);

  if (!isMatch) {
    throw new Error('invalid_credentials');
  }

  return await update(user.id, {
    sign_in_count: user.sign_in_count + 1,
    last_sign_in_at: new Date().toISOString(),
  });
};

export const signup = async (email, password) => {
  const user = await findByEmail(email);

  if (!isEmpty(user)) {
    throw new Error('email_unavailable');
  }

  if (!isPasswordSecure(password)) {
    throw new Error('weak_password');
  }

  const hashedPassword = await hashPassword(password);

  return await create({
    email,
    encrypted_password: hashedPassword,
  });
};

export const sendEmailAddressVerificationEmail = async ({
  email,
  checkBeforeSend,
}) => {
  const user = await findByEmail(email);

  if (user.email_verified) {
    throw new Error('email_verified_already');
  }

  if (
    checkBeforeSend &&
    !isExpired(
      user.verify_email_sent_at,
      VERIFY_EMAIL_TOKEN_EXPIRATION_DURATION_IN_MINUTES
    )
  ) {
    return false;
  }

  const verify_email_token = await generatePinToken();

  await update(user.id, {
    verify_email_token,
    verify_email_sent_at: new Date().toISOString(),
  });

  await sendMail({
    to: [user.email],
    subject: `Code de confirmation api.gouv.fr : ${verify_email_token}`,
    template: 'verify-email',
    params: {
      verify_email_token,
    },
  });

  return true;
};

export const verifyEmail = async token => {
  const user = await findByVerifyEmailToken(token);

  if (isEmpty(user)) {
    throw new Error('invalid_token');
  }

  const isTokenExpired = isExpired(
    user.verify_email_sent_at,
    VERIFY_EMAIL_TOKEN_EXPIRATION_DURATION_IN_MINUTES
  );

  if (isTokenExpired) {
    throw new Error('invalid_token');
  }

  return await update(user.id, {
    email_verified: true,
    verify_email_token: null,
    verify_email_sent_at: null,
  });
};

export const sendSendMagicLinkEmail = async email => {
  let user = await findByEmail(email);

  if (isEmpty(user)) {
    user = await create({
      email,
    });
  }

  const magicLinkToken = await generateToken();

  await update(user.id, {
    magic_link_token: magicLinkToken,
    magic_link_sent_at: new Date().toISOString(),
  });

  await sendMail({
    to: [user.email],
    subject: 'Connexion avec un lien magique',
    template: 'magic-link',
    params: {
      magic_link: `${API_AUTH_HOST}/users/sign-in-with-magic-link?magic_link_token=${magicLinkToken}`,
    },
  });

  return true;
};

export const loginWithMagicLink = async token => {
  // check that token as not the default empty value as it will match all users
  if (!token) {
    throw new Error('invalid_magic_link');
  }

  const user = await findByMagicLinkToken(token);

  if (isEmpty(user)) {
    throw new Error('invalid_magic_link');
  }

  const isTokenExpired = isExpired(
    user.magic_link_sent_at,
    MAGIC_LINK_TOKEN_EXPIRATION_DURATION_IN_MINUTES
  );

  if (isTokenExpired) {
    throw new Error('invalid_magic_link');
  }

  return await update(user.id, {
    email_verified: true,
    magic_link_token: null,
    magic_link_sent_at: null,
  });
};

export const sendResetPasswordEmail = async email => {
  const user = await findByEmail(email);

  if (isEmpty(user)) {
    // failing silently as we do not want to give info on whether the user exists or not
    return true;
  }

  const resetPasswordToken = await generateToken();

  await update(user.id, {
    reset_password_token: resetPasswordToken,
    reset_password_sent_at: new Date().toISOString(),
  });

  await sendMail({
    to: [user.email],
    subject: 'Instructions pour la réinitialisation du mot de passe',
    template: 'reset-password',
    params: {
      reset_password_link: `${API_AUTH_HOST}/users/change-password?reset_password_token=${resetPasswordToken}`,
    },
  });

  return true;
};

export const changePassword = async (token, password) => {
  // check that token as not the default empty value as it will match all users
  if (!token) {
    throw new Error('invalid_token');
  }

  const user = await findByResetPasswordToken(token);

  if (isEmpty(user)) {
    throw new Error('invalid_token');
  }

  const isTokenExpired = isExpired(
    user.reset_password_sent_at,
    RESET_PASSWORD_TOKEN_EXPIRATION_DURATION_IN_MINUTES
  );

  if (isTokenExpired) {
    throw new Error('invalid_token');
  }

  if (!isPasswordSecure(password)) {
    throw new Error('weak_password');
  }

  const hashedPassword = await hashPassword(password);

  return await update(user.id, {
    encrypted_password: hashedPassword,
    reset_password_token: null,
    reset_password_sent_at: null,
  });
};

export const updatePersonalInformations = async (
  userId,
  { given_name, family_name, phone_number, job }
) => {
  if (!isString(given_name) || !isString(family_name) || !isString(job)) {
    throw new Error('invalid_personal_informations');
  }
  if (!isPhoneNumberValid(phone_number)) {
    throw new Error('invalid_personal_informations');
  }

  return await update(userId, {
    given_name,
    family_name,
    phone_number,
    job,
  });
};
