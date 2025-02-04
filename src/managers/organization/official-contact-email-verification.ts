import { isEmpty } from 'lodash';
import {
  ApiAnnuaireError,
  InvalidTokenError,
  NotFoundError,
  OfficialContactEmailVerificationNotNeededError,
} from '../../errors';
import { isExpired } from '../../services/is-expired';
import { generateDicewarePassword } from '../../services/security';
import { sendMail } from '../../connectors/sendinblue';
import {
  findById as findOrganizationById,
  getUsers,
} from '../../repositories/organization/getters';
import { getContactEmail } from '../../connectors/api-annuaire';
import { updateUserOrganizationLink } from '../../repositories/organization/setters';

const OFFICIAL_CONTACT_EMAIL_VERIFICATION_TOKEN_EXPIRATION_DURATION_IN_MINUTES = 60;

export const sendOfficialContactEmailVerificationEmail = async ({
  user_id,
  organization_id,
  checkBeforeSend,
}: {
  user_id: number;
  organization_id: number;
  checkBeforeSend: boolean;
}): Promise<{
  codeSent: boolean;
  contactEmail: string;
  libelle: string | null;
}> => {
  const organizationUsers = await getUsers(organization_id);
  const user = organizationUsers.find(({ id }) => id === user_id);
  const organization = await findOrganizationById(organization_id);

  // The user should be in the organization already
  if (isEmpty(user) || isEmpty(organization)) {
    throw new NotFoundError();
  }

  const {
    needs_official_contact_email_verification,
    official_contact_email_verification_sent_at,
  } = user;

  if (!needs_official_contact_email_verification) {
    throw new OfficialContactEmailVerificationNotNeededError();
  }

  const {
    cached_code_officiel_geographique,
    cached_libelle: libelle,
  } = organization;

  let contactEmail;
  try {
    contactEmail = await getContactEmail(cached_code_officiel_geographique);
  } catch (error) {
    throw new ApiAnnuaireError();
  }

  if (
    checkBeforeSend &&
    !isExpired(
      official_contact_email_verification_sent_at,
      OFFICIAL_CONTACT_EMAIL_VERIFICATION_TOKEN_EXPIRATION_DURATION_IN_MINUTES
    )
  ) {
    return { codeSent: false, contactEmail, libelle };
  }

  const official_contact_email_verification_token = await generateDicewarePassword();

  await updateUserOrganizationLink(organization_id, user_id, {
    official_contact_email_verification_token,
    official_contact_email_verification_sent_at: new Date(),
  });

  const { given_name, family_name, email } = user;

  await sendMail({
    to: [contactEmail],
    subject: `[MonComptePro] Authentifier un email sur MonComptePro`,
    template: 'official-contact-email-verification',
    params: {
      given_name,
      family_name,
      email,
      libelle,
      official_contact_email_verification_token,
    },
  });

  return { codeSent: true, contactEmail, libelle };
};

export const verifyOfficialContactEmailToken = async ({
  user_id,
  organization_id,
  token,
}: {
  user_id: number;
  organization_id: number;
  token: string;
}): Promise<UserOrganizationLink> => {
  const organizationUsers = await getUsers(organization_id);
  const user = organizationUsers.find(({ id }) => id === user_id);
  const organization = await findOrganizationById(organization_id);

  // The user should be in the organization already
  if (isEmpty(user) || isEmpty(organization)) {
    throw new NotFoundError();
  }

  const {
    official_contact_email_verification_token,
    official_contact_email_verification_sent_at,
  } = user;

  if (official_contact_email_verification_token !== token) {
    throw new InvalidTokenError();
  }

  const isTokenExpired = isExpired(
    official_contact_email_verification_sent_at,
    OFFICIAL_CONTACT_EMAIL_VERIFICATION_TOKEN_EXPIRATION_DURATION_IN_MINUTES
  );

  if (isTokenExpired) {
    throw new InvalidTokenError();
  }

  return await updateUserOrganizationLink(organization_id, user_id, {
    needs_official_contact_email_verification: false,
    official_contact_email_verification_token: null,
    official_contact_email_verification_sent_at: null,
  });
};
